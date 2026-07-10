"use strict";
// ============================================================
// BILLING + AI + ALERT + MASTER MODULE (FIXED)
// ============================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.billingRouter = void 0;
const express_1 = require("express");
const db_1 = require("../../config/db");
const commandBus_1 = require("../../cqrs/commandBus");
const queryBus_1 = require("../../cqrs/queryBus");
const auth_service_1 = require("../auth/auth.service");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const gemini_service_1 = require("./gemini.service");
// ─────────────────────────────────────────────────────────────
// COMMON RESPONSE
// ─────────────────────────────────────────────────────────────
function ok(res, data, status = 200) {
    res.status(status).json({ success: true, data });
}
function fail(res, msg, status = 400) {
    res.status(status).json({ success: false, error: msg });
}
class GenerateInvoicesCommandHandler {
    async execute(cmd) {
        const periodStart = new Date(cmd.month);
        const periodEnd = new Date(periodStart);
        periodEnd.setMonth(periodEnd.getMonth() + 1);
        const tenants = await (0, db_1.query)(`
      SELECT t.*, ts.amount_inr, ts.billing_cycle, ts.id as sub_id
      FROM tenants t
      JOIN tenant_subscriptions ts ON ts.tenant_id=t.id AND ts.is_current=TRUE
      WHERE t.billing_status IN ('active','past_due') AND ts.amount_inr > 0
    `);
        const invoices = [];
        for (const t of tenants) {
            const exists = await (0, db_1.queryOne)(`SELECT id FROM invoices WHERE tenant_id=$1 AND billing_period_from=$2`, [t.id, periodStart]);
            if (exists) {
                invoices.push({ ...exists, skipped: true });
                continue;
            }
            const subtotal = Number(t.amount_inr);
            const gstAmt = subtotal * 0.18;
            const total = subtotal + gstAmt;
            if (!cmd.dryRun) {
                const [inv] = await (0, db_1.query)(`INSERT INTO invoices (tenant_id,subscription_id,plan_type,billing_period_from,billing_period_to,subtotal_inr,gst_rate,gst_amount_inr,total_inr,status,issued_at)
           VALUES ($1,$2,$3,$4,$5,$6,18,$7,$8,'issued',NOW())
           RETURNING *`, [t.id, t.sub_id, t.plan_type, periodStart, periodEnd, subtotal, gstAmt, total]);
                invoices.push(inv);
            }
            else {
                invoices.push({ tenant_id: t.id, total_inr: total, dry_run: true });
            }
        }
        return { invoices };
    }
}
class ListInvoicesQueryHandler {
    async execute(q) {
        const offset = (q.page - 1) * q.limit;
        const items = await (0, db_1.query)(`SELECT * FROM invoices
       WHERE ($1::uuid IS NULL OR tenant_id=$1)
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`, [q.tenantId || null, q.limit, offset]);
        return { items };
    }
}
// REGISTER
commandBus_1.commandBus.register('billing.generateInvoices', new GenerateInvoicesCommandHandler());
queryBus_1.queryBus.register('billing.invoices', new ListInvoicesQueryHandler());
// ---------------- ROUTER ----------------
exports.billingRouter = (0, express_1.Router)();
exports.billingRouter.use(auth_service_1.authMiddleware);
exports.billingRouter.get('/invoices', async (req, res) => {
    try {
        const user = req.user;
        const result = await queryBus_1.queryBus.execute({
            type: 'billing.invoices',
            tenantId: user.tenantId,
            page: Number(req.query.page) || 1,
            limit: Number(req.query.limit) || 20,
        });
        ok(res, result);
    }
    catch (e) {
        fail(res, e.message);
    }
});
class GenerateReportCommandHandler {
    constructor() {
        this.anthropic = new sdk_1.default({
            apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || 'dummy_key',
        });
    }
    async execute(cmd) {
        const cleanEmail = cmd.email?.toLowerCase();
        const items = await (0, db_1.query)(`SELECT id,name,current_stock FROM items WHERE store_id=$1 LIMIT 5`, [cmd.storeId]);
        const prompt = `Forecast demand: ${JSON.stringify(items)}`;
        let responseText = '';
        if (process.env.AI_PROVIDER === 'gemini') {
            const geminiRes = await (0, gemini_service_1.callGemini)({
                prompt: prompt,
                maxTokens: 500,
            });
            responseText = geminiRes.text;
        }
        else {
            const msg = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 500,
                messages: [{ role: 'user', content: prompt }],
            });
            responseText = msg.content[0].text;
        }
        return {
            email: cleanEmail,
            response: responseText,
        };
    }
}
commandBus_1.commandBus.register('ai.generateReport', new GenerateReportCommandHandler());
// ============================================================
// 🟢 DASHBOARD (FIXED)
// ============================================================
