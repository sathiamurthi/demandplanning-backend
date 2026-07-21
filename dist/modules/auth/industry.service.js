"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.industryRouter = void 0;
// ============================================================
// INDUSTRY MODULE — Full CQRS Router
// POST/PUT/GET/DELETE industry configs
// ============================================================
const express_1 = require("express");
const zod_1 = require("zod");
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
class CreateIndustryCommandHandler {
    async execute(cmd) {
        const exists = await (0, db_1.queryOne)('SELECT id FROM industry_configs WHERE industry_id=$1', [cmd.industryId]);
        if (exists)
            throw new Error(`Industry "${cmd.industryId}" already exists`);
        const [row] = await (0, db_1.query)(`INSERT INTO industry_configs
         (industry_id, display_name, item_noun, default_unit_symbol,
          domain_keywords, off_topic_keywords, seasonal_signals,
          prompt_context, low_stock_days, expiry_warn_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`, [
            cmd.industryId, cmd.displayName, cmd.itemNoun, cmd.defaultUnitSymbol,
            cmd.domainKeywords, cmd.offTopicKeywords, cmd.seasonalSignals,
            cmd.promptContext, cmd.lowStockDays, cmd.expiryWarnDays,
        ]);
        return row;
    }
}
class UpdateIndustryCommandHandler {
    async execute(cmd) {
        const sets = [];
        const vals = [];
        let i = 1;
        if (cmd.displayName !== undefined) {
            sets.push(`display_name=$${i++}`);
            vals.push(cmd.displayName);
        }
        if (cmd.itemNoun !== undefined) {
            sets.push(`item_noun=$${i++}`);
            vals.push(cmd.itemNoun);
        }
        if (cmd.defaultUnitSymbol !== undefined) {
            sets.push(`default_unit_symbol=$${i++}`);
            vals.push(cmd.defaultUnitSymbol);
        }
        if (cmd.domainKeywords !== undefined) {
            sets.push(`domain_keywords=$${i++}`);
            vals.push(cmd.domainKeywords);
        }
        if (cmd.offTopicKeywords !== undefined) {
            sets.push(`off_topic_keywords=$${i++}`);
            vals.push(cmd.offTopicKeywords);
        }
        if (cmd.seasonalSignals !== undefined) {
            sets.push(`seasonal_signals=$${i++}`);
            vals.push(cmd.seasonalSignals);
        }
        if (cmd.promptContext !== undefined) {
            sets.push(`prompt_context=$${i++}`);
            vals.push(cmd.promptContext);
        }
        if (cmd.lowStockDays !== undefined) {
            sets.push(`low_stock_days=$${i++}`);
            vals.push(cmd.lowStockDays);
        }
        if (cmd.expiryWarnDays !== undefined) {
            sets.push(`expiry_warn_days=$${i++}`);
            vals.push(cmd.expiryWarnDays);
        }
        if (cmd.isActive !== undefined) {
            sets.push(`is_active=$${i++}`);
            vals.push(cmd.isActive);
        }
        if (!sets.length)
            throw new Error('Nothing to update');
        sets.push(`updated_at=NOW()`);
        vals.push(cmd.industryId);
        const [row] = await (0, db_1.query)(`UPDATE industry_configs SET ${sets.join(',')} WHERE industry_id=$${i} RETURNING *`, vals);
        if (!row)
            throw new Error('Industry config not found');
        return row;
    }
}
class DeleteIndustryCommandHandler {
    async execute(cmd) {
        // Check no tenants are using it
        const tenantCount = await (0, db_1.queryOne)('SELECT COUNT(*)::int as count FROM tenants WHERE industry_id=$1 AND is_active=TRUE', [cmd.industryId]);
        if ((tenantCount?.count || 0) > 0) {
            throw new Error(`Cannot deactivate — ${tenantCount?.count} active tenant(s) using this industry`);
        }
        await (0, db_1.query)(`UPDATE industry_configs SET is_active=FALSE, updated_at=NOW() WHERE industry_id=$1`, [cmd.industryId]);
        return { message: `Industry "${cmd.industryId}" deactivated` };
    }
}
class ListIndustriesQueryHandler {
    async execute(q) {
        const where = q.includeInactive ? '' : 'WHERE is_active=TRUE';
        return (0, db_1.query)(`SELECT id, industry_id, display_name FROM industry_configs ${where} ORDER BY display_name`);
    }
}
class GetIndustryQueryHandler {
    async execute(q) {
        const row = await (0, db_1.queryOne)(`SELECT ic.*,
              COUNT(t.id)::int as tenant_count,
              COUNT(t.id) FILTER (WHERE t.billing_status='active')::int as active_tenants
       FROM industry_configs ic
       LEFT JOIN tenants t ON t.industry_id=ic.industry_id
       WHERE ic.industry_id=$1
       GROUP BY ic.id, ic.industry_id`, [q.industryId]);
        if (!row)
            throw new Error('Industry config not found');
        return row;
    }
}
class GetIndustryStatsQueryHandler {
    async execute(_q) {
        return (0, db_1.query)(`SELECT ic.industry_id, ic.display_name, ic.is_active,
              COUNT(t.id)::int as total_tenants,
              COUNT(t.id) FILTER (WHERE t.billing_status='active')::int as active_tenants,
              COUNT(t.id) FILTER (WHERE t.billing_status='trial')::int as trial_tenants,
              COALESCE(SUM(bp.price_monthly_inr) FILTER (WHERE t.billing_status IN ('active','past_due')),0) as total_mrr
       FROM industry_configs ic
       LEFT JOIN tenants t ON t.industry_id=ic.industry_id AND t.is_active=TRUE
       LEFT JOIN billing_plans bp ON bp.plan_type=t.plan_type
       GROUP BY ic.id, ic.industry_id, ic.display_name, ic.is_active
       ORDER BY total_tenants DESC`);
    }
}
// ── Register ─────────────────────────────────────────────────
commandBus_1.commandBus.register('industry.create', new CreateIndustryCommandHandler());
commandBus_1.commandBus.register('industry.update', new UpdateIndustryCommandHandler());
commandBus_1.commandBus.register('industry.delete', new DeleteIndustryCommandHandler());
queryBus_1.queryBus.register('industry.list', new ListIndustriesQueryHandler());
queryBus_1.queryBus.register('industry.get', new GetIndustryQueryHandler());
queryBus_1.queryBus.register('industry.stats', new GetIndustryStatsQueryHandler());
// ── Validation ────────────────────────────────────────────────
const CreateIndustrySchema = zod_1.z.object({
    industryId: zod_1.z.string().min(2).regex(/^[a-z0-9_]+$/, 'Must be lowercase alphanumeric with underscores'),
    displayName: zod_1.z.string().min(2),
    itemNoun: zod_1.z.string().min(1),
    defaultUnitSymbol: zod_1.z.string().min(1),
    domainKeywords: zod_1.z.array(zod_1.z.string()).min(1),
    offTopicKeywords: zod_1.z.array(zod_1.z.string()).default([]),
    seasonalSignals: zod_1.z.array(zod_1.z.string()).default([]),
    promptContext: zod_1.z.string().min(10),
    lowStockDays: zod_1.z.number().int().positive().default(5),
    expiryWarnDays: zod_1.z.number().int().positive().default(30),
});
const UpdateIndustrySchema = zod_1.z.object({
    displayName: zod_1.z.string().optional(),
    itemNoun: zod_1.z.string().optional(),
    defaultUnitSymbol: zod_1.z.string().optional(),
    domainKeywords: zod_1.z.array(zod_1.z.string()).optional(),
    offTopicKeywords: zod_1.z.array(zod_1.z.string()).optional(),
    seasonalSignals: zod_1.z.array(zod_1.z.string()).optional(),
    promptContext: zod_1.z.string().optional(),
    lowStockDays: zod_1.z.number().int().positive().optional(),
    expiryWarnDays: zod_1.z.number().int().positive().optional(),
    isActive: zod_1.z.boolean().optional(),
});
// ── Router ────────────────────────────────────────────────────
exports.industryRouter = (0, express_1.Router)();
// GET /v1/industries  — public
exports.industryRouter.get('/', async (req, res) => {
    try {
        const r = await queryBus_1.queryBus.execute({
            type: 'industry.list',
            includeInactive: req.query.includeInactive === 'true',
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// GET /v1/industries/stats  [superadmin]
exports.industryRouter.get('/stats', auth_service_1.authMiddleware, (0, roleGuard_1.requireRole)('superadmin'), async (_req, res) => {
    try {
        const r = await queryBus_1.queryBus.execute({ type: 'industry.stats' });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// GET /v1/industries/:id  — public
exports.industryRouter.get('/:id', async (req, res) => {
    try {
        const r = await queryBus_1.queryBus.execute({ type: 'industry.get', industryId: req.params.id });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message, 404);
    }
});
// POST /v1/industries  [superadmin]
exports.industryRouter.post('/', auth_service_1.authMiddleware, (0, roleGuard_1.requireRole)('superadmin'), async (req, res) => {
    try {
        const body = CreateIndustrySchema.parse(req.body);
        const r = await commandBus_1.commandBus.execute({ type: 'industry.create', ...body });
        ok(res, r, 201);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// PUT /v1/industries/:id  [superadmin]
exports.industryRouter.put('/:id', auth_service_1.authMiddleware, (0, roleGuard_1.requireRole)('superadmin'), async (req, res) => {
    try {
        const body = UpdateIndustrySchema.parse(req.body);
        const r = await commandBus_1.commandBus.execute({ type: 'industry.update', industryId: req.params.id, ...body });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// DELETE /v1/industries/:id  [superadmin]
exports.industryRouter.delete('/:id', auth_service_1.authMiddleware, (0, roleGuard_1.requireRole)('superadmin'), async (req, res) => {
    try {
        const r = await commandBus_1.commandBus.execute({ type: 'industry.delete', industryId: req.params.id });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
