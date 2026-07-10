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
exports.tenantRouter = void 0;
// ============================================================
// TENANTS MODULE — Full CQRS + Router
// ============================================================
const express_1 = require("express");
const zod_1 = require("zod");
const bcrypt = __importStar(require("bcryptjs"));
const db_1 = require("../../config/db");
const commandBus_1 = require("../../cqrs/commandBus");
const queryBus_1 = require("../../cqrs/queryBus");
const auth_service_1 = require("../auth/auth.service");
const roleGuard_1 = require("../../core/guards/roleGuard");
function ok(res, data, status = 200) {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res, msg, status = 400) {
    res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}
class CreateTenantCommandHandler {
    async execute(cmd) {
        const slugExists = await (0, db_1.queryOne)('SELECT id FROM tenants WHERE slug = $1', [cmd.slug]);
        if (slugExists)
            throw new Error(`Slug "${cmd.slug}" already taken`);
        const emailExists = await (0, db_1.queryOne)('SELECT id FROM users WHERE email = $1', [cmd.ownerEmail.toLowerCase()]);
        if (emailExists)
            throw new Error('Owner email already registered');
        return (0, db_1.withTransaction)(async (client) => {
            // 1. Create tenant
            const trialEndsAt = new Date(Date.now() + 14 * 86400 * 1000);
            const [tenant] = await client.query(`INSERT INTO tenants (name,slug,industry_id,plan_type,billing_status,trial_ends_at,billing_email,billing_phone,gst_number,city,state,pincode,created_by)
         VALUES ($1,$2,$3,$4,'trial',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [cmd.name, cmd.slug, cmd.industryId, cmd.planType, trialEndsAt, cmd.billingEmail,
                cmd.billingPhone || null, cmd.gstNumber || null, cmd.city || null, cmd.state || null,
                cmd.pincode || null, cmd.createdBy]).then(r => r.rows);
            // 2. Create default store
            const [store] = await client.query(`INSERT INTO stores (tenant_id,name,city,state) VALUES ($1,$2,$3,$4) RETURNING id`, [tenant.id, cmd.name + ' Store 1', cmd.city || null, cmd.state || null]).then(r => r.rows);
            // 3. Create owner user
            const passwordHash = await bcrypt.hash(cmd.ownerPassword, 10);
            const [owner] = await client.query(`INSERT INTO users (tenant_id,store_id,email,password_hash,role,first_name,last_name,is_active,is_email_verified)
         VALUES ($1,$2,$3,$4,'owner',$5,$6,TRUE,FALSE) RETURNING id,email,role`, [tenant.id, null, cmd.ownerEmail.toLowerCase(), passwordHash, cmd.ownerFirstName, cmd.ownerLastName]).then(r => r.rows);
            // 4. Create subscription
            const plan = await client.query('SELECT * FROM billing_plans WHERE plan_type=$1', [cmd.planType]).then(r => r.rows[0]);
            await client.query(`INSERT INTO tenant_subscriptions (tenant_id,plan_type,amount_inr,starts_at,renews_at)
         VALUES ($1,$2,$3,NOW(),NOW() + INTERVAL '1 month')`, [tenant.id, cmd.planType, plan?.price_monthly_inr || 0]);
            return { tenant, store, owner };
        });
    }
}
class UpdateTenantCommandHandler {
    async execute(cmd) {
        const sets = [];
        const vals = [];
        let i = 1;
        if (cmd.name) {
            sets.push(`name=$${i++}`);
            vals.push(cmd.name);
        }
        if (cmd.billingEmail) {
            sets.push(`billing_email=$${i++}`);
            vals.push(cmd.billingEmail);
        }
        if (cmd.billingPhone) {
            sets.push(`billing_phone=$${i++}`);
            vals.push(cmd.billingPhone);
        }
        if (cmd.gstNumber) {
            sets.push(`gst_number=$${i++}`);
            vals.push(cmd.gstNumber);
        }
        if (cmd.city) {
            sets.push(`city=$${i++}`);
            vals.push(cmd.city);
        }
        if (cmd.state) {
            sets.push(`state=$${i++}`);
            vals.push(cmd.state);
        }
        if (cmd.pincode) {
            sets.push(`pincode=$${i++}`);
            vals.push(cmd.pincode);
        }
        if (cmd.logoUrl) {
            sets.push(`logo_url=$${i++}`);
            vals.push(cmd.logoUrl);
        }
        if (cmd.timezone) {
            sets.push(`timezone=$${i++}`);
            vals.push(cmd.timezone);
        }
        sets.push(`updated_at=NOW()`);
        vals.push(cmd.tenantId);
        const [updated] = await (0, db_1.query)(`UPDATE tenants SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
        if (!updated)
            throw new Error('Tenant not found');
        return updated;
    }
}
class UpgradePlanCommandHandler {
    async execute(cmd) {
        const plan = await (0, db_1.queryOne)('SELECT * FROM billing_plans WHERE plan_type=$1', [cmd.planType]);
        if (!plan)
            throw new Error('Plan not found');
        const amount = cmd.billingCycle === 'yearly' ? plan.price_yearly_inr : plan.price_monthly_inr;
        return (0, db_1.withTransaction)(async (client) => {
            await client.query(`UPDATE tenant_subscriptions SET is_current=FALSE WHERE tenant_id=$1`, [cmd.tenantId]);
            await client.query(`INSERT INTO tenant_subscriptions (tenant_id,plan_type,billing_cycle,amount_inr,starts_at,renews_at,payment_method,external_sub_id)
         VALUES ($1,$2,$3,$4,NOW(), NOW() + INTERVAL '1 ${cmd.billingCycle === 'yearly' ? 'year' : 'month'}', $5,$6)`, [cmd.tenantId, cmd.planType, cmd.billingCycle, amount, cmd.paymentMethod || null, cmd.externalSubId || null]);
            const [tenant] = await client.query(`UPDATE tenants SET plan_type=$1, billing_status='active', updated_at=NOW() WHERE id=$2 RETURNING *`, [cmd.planType, cmd.tenantId]).then(r => r.rows);
            return tenant;
        });
    }
}
class DeactivateTenantCommandHandler {
    async execute(cmd) {
        await (0, db_1.query)(`UPDATE tenants SET is_active=FALSE, billing_status='cancelled', updated_at=NOW() WHERE id=$1`, [cmd.tenantId]);
        return { message: 'Tenant deactivated' };
    }
}
class ListTenantsQueryHandler {
    async execute(q) {
        const offset = (q.page - 1) * q.limit;
        const conditions = ['t.is_active=TRUE'];
        const vals = [];
        let i = 1;
        if (q.search) {
            conditions.push(`(t.name ILIKE $${i} OR t.slug ILIKE $${i})`);
            vals.push(`%${q.search}%`);
            i++;
        }
        if (q.industryId) {
            conditions.push(`t.industry_id=$${i++}`);
            vals.push(q.industryId);
        }
        if (q.planType) {
            conditions.push(`t.plan_type=$${i++}`);
            vals.push(q.planType);
        }
        if (q.billingStatus) {
            conditions.push(`t.billing_status=$${i++}`);
            vals.push(q.billingStatus);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const [{ count }] = await (0, db_1.query)(`SELECT COUNT(*) FROM tenants t ${where}`, vals);
        vals.push(q.limit, offset);
        const items = await (0, db_1.query)(`SELECT t.*, ic.display_name as industry_name,
              bp.price_monthly_inr, bp.display_name as plan_name,
              (SELECT COUNT(*) FROM stores s WHERE s.tenant_id=t.id AND s.is_active=TRUE)::int as store_count,
              (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id AND u.is_active=TRUE)::int as user_count
       FROM tenants t
       LEFT JOIN industry_configs ic ON ic.industry_id=t.industry_id
       LEFT JOIN billing_plans bp ON bp.plan_type=t.plan_type
       ${where} ORDER BY t.created_at DESC LIMIT $${i} OFFSET $${i + 1}`, vals);
        return { items, total: parseInt(count), page: q.page, limit: q.limit, pages: Math.ceil(count / q.limit) };
    }
}
class GetTenantQueryHandler {
    async execute(q) {
        const tenant = await (0, db_1.queryOne)(`SELECT t.*, ic.display_name as industry_name, ic.item_noun, ic.default_unit_symbol,
              bp.display_name as plan_name, bp.price_monthly_inr, bp.max_stores, bp.max_users,
              bp.ai_reports_per_month, bp.whatsapp_alerts, bp.api_access,
              ts.billing_cycle, ts.starts_at as sub_starts, ts.renews_at as sub_renews,
              tu.ai_reports_used, tu.active_stores, tu.active_users
       FROM tenants t
       LEFT JOIN industry_configs ic ON ic.industry_id=t.industry_id
       LEFT JOIN billing_plans bp ON bp.plan_type=t.plan_type
       LEFT JOIN tenant_subscriptions ts ON ts.tenant_id=t.id AND ts.is_current=TRUE
       LEFT JOIN tenant_usage tu ON tu.tenant_id=t.id AND tu.month=DATE_TRUNC('month',NOW())
       WHERE t.id=$1`, [q.tenantId]);
        if (!tenant)
            throw new Error('Tenant not found');
        return tenant;
    }
}
class GetTenantUsageQueryHandler {
    async execute(q) {
        const usage = await (0, db_1.queryOne)(`SELECT tu.*, bp.ai_reports_per_month, bp.max_stores, bp.max_users, bp.max_items_per_store
       FROM tenant_usage tu
       JOIN tenants t ON t.id=tu.tenant_id
       JOIN billing_plans bp ON bp.plan_type=t.plan_type
       WHERE tu.tenant_id=$1 AND tu.month=DATE_TRUNC('month',NOW())`, [q.tenantId]);
        const storeCount = await (0, db_1.queryOne)('SELECT COUNT(*)::int as count FROM stores WHERE tenant_id=$1 AND is_active=TRUE', [q.tenantId]);
        const userCount = await (0, db_1.queryOne)('SELECT COUNT(*)::int as count FROM users  WHERE tenant_id=$1 AND is_active=TRUE', [q.tenantId]);
        return { ...usage, currentStores: storeCount?.count || 0, currentUsers: userCount?.count || 0 };
    }
}
// Register
commandBus_1.commandBus.register('tenant.create', new CreateTenantCommandHandler());
commandBus_1.commandBus.register('tenant.update', new UpdateTenantCommandHandler());
commandBus_1.commandBus.register('tenant.upgradePlan', new UpgradePlanCommandHandler());
commandBus_1.commandBus.register('tenant.deactivate', new DeactivateTenantCommandHandler());
queryBus_1.queryBus.register('tenant.list', new ListTenantsQueryHandler());
queryBus_1.queryBus.register('tenant.get', new GetTenantQueryHandler());
queryBus_1.queryBus.register('tenant.usage', new GetTenantUsageQueryHandler());
// ── Router ───────────────────────────────────────────────────
exports.tenantRouter = (0, express_1.Router)();
exports.tenantRouter.use(auth_service_1.authMiddleware);
const CreateSchema = zod_1.z.object({
    name: zod_1.z.string().min(2), slug: zod_1.z.string().min(2).regex(/^[a-z0-9-]+$/),
    industryId: zod_1.z.string(), planType: zod_1.z.enum(['free', 'starter', 'growth', 'enterprise']),
    billingEmail: zod_1.z.string().email(), billingPhone: zod_1.z.string().optional(),
    gstNumber: zod_1.z.string().optional(), city: zod_1.z.string().optional(),
    state: zod_1.z.string().optional(), pincode: zod_1.z.string().optional(),
    ownerEmail: zod_1.z.string().email(), ownerPassword: zod_1.z.string().min(8),
    ownerFirstName: zod_1.z.string().min(1), ownerLastName: zod_1.z.string().min(1),
});
// GET /v1/tenants
exports.tenantRouter.get('/', (0, roleGuard_1.requireRole)('superadmin'), async (req, res) => {
    try {
        const result = await queryBus_1.queryBus.execute({
            type: 'tenant.list',
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || 20,
            search: req.query.search,
            industryId: req.query.industryId,
            planType: req.query.planType,
            billingStatus: req.query.billingStatus,
        });
        ok(res, result);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// POST /v1/tenants
exports.tenantRouter.post('/', (0, roleGuard_1.requireRole)('superadmin'), async (req, res) => {
    try {
        const body = CreateSchema.parse(req.body);
        const result = await commandBus_1.commandBus.execute({ type: 'tenant.create', ...body, createdBy: req.user.sub });
        ok(res, result, 201);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// GET /v1/tenants/:tenantId
exports.tenantRouter.get('/:tenantId', (0, roleGuard_1.requireTenantAccess)(), async (req, res) => {
    try {
        const result = await queryBus_1.queryBus.execute({ type: 'tenant.get', tenantId: req.params.tenantId });
        ok(res, result);
    }
    catch (e) {
        fail(res, e.message, 404);
    }
});
// PUT /v1/tenants/:tenantId
exports.tenantRouter.put('/:tenantId', (0, roleGuard_1.requireTenantAccess)(), (0, roleGuard_1.requireRole)('superadmin', 'owner'), async (req, res) => {
    try {
        const result = await commandBus_1.commandBus.execute({ type: 'tenant.update', tenantId: req.params.tenantId, ...req.body });
        ok(res, result);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// DELETE /v1/tenants/:tenantId
exports.tenantRouter.delete('/:tenantId', (0, roleGuard_1.requireRole)('superadmin'), async (req, res) => {
    try {
        const result = await commandBus_1.commandBus.execute({ type: 'tenant.deactivate', tenantId: req.params.tenantId });
        ok(res, result);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// GET /v1/tenants/:tenantId/usage
exports.tenantRouter.get('/:tenantId/usage', (0, roleGuard_1.requireTenantAccess)(), async (req, res) => {
    try {
        const result = await queryBus_1.queryBus.execute({ type: 'tenant.usage', tenantId: req.params.tenantId });
        ok(res, result);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// PUT /v1/tenants/:tenantId/subscription
exports.tenantRouter.put('/:tenantId/subscription', (0, roleGuard_1.requireRole)('superadmin'), async (req, res) => {
    try {
        const result = await commandBus_1.commandBus.execute({ type: 'tenant.upgradePlan', tenantId: req.params.tenantId, ...req.body });
        ok(res, result);
    }
    catch (e) {
        fail(res, e.message);
    }
});
