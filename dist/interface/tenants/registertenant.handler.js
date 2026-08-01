"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegisterTenantCommandHandler = void 0;
// handlers/registerTenant.handler.ts
const db_1 = require("../../config/db");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const slugify_1 = __importDefault(require("slugify"));
const email_1 = require("../../utils/email");
const whatsapp_1 = require("../../utils/whatsapp");
const default_categories_1 = require("../../config/default_categories");
class RegisterTenantCommandHandler {
    async execute(command) {
        const { firstName, lastName, industry_id, companyName, email, phone, password, source } = command.payload;
        const emailNorm = email ? email.toLowerCase().trim() : null;
        const phoneNorm = phone ? phone.trim() : null;
        if (!emailNorm && !phoneNorm)
            throw new Error('Email or phone number is required');
        if (emailNorm) {
            const existing = await (0, db_1.queryOne)(`SELECT id FROM users WHERE email=$1`, [emailNorm]);
            if (existing)
                throw new Error('Email already registered. Please log in or use a different email.');
        }
        if (phoneNorm) {
            const existing = await (0, db_1.queryOne)(`SELECT id FROM users WHERE phone=$1 AND phone IS NOT NULL AND phone<>''`, [phoneNorm]);
            if (existing)
                throw new Error('Phone number already registered. Please log in or use a different number.');
        }
        const hashed = await bcryptjs_1.default.hash(password, 10);
        const slugBase = companyName || emailNorm?.split('@')[0] || phoneNorm || 'business';
        const baseSlug = (0, slugify_1.default)(slugBase, { lower: true, strict: true });
        let slug = baseSlug;
        let attempt = 0;
        while (true) {
            const taken = await (0, db_1.queryOne)(`SELECT id FROM tenants WHERE slug=$1`, [slug]);
            if (!taken)
                break;
            attempt++;
            slug = `${baseSlug}-${attempt}`;
        }
        const industryConfig = await (0, db_1.queryOne)(`SELECT id, industry_id FROM industry_configs WHERE industry_id=$1 OR id::text=$1 LIMIT 1`, [industry_id]);
        const resolvedEmail = emailNorm || `user_${Date.now()}@noemail.local`;
        const regType = phoneNorm && !emailNorm ? 'phone' : 'email';
        // TeaFactory360 ("factory") signups need a superadmin to approve the
        // new tenant before its owner can log in — everything else keeps
        // auto-activating exactly as before. The existing login flow already
        // checks tenants.is_active and rejects with 'Account is inactive', and
        // the superadmin Tenants page already has a working Approve/Deactivate
        // UI (built for this, just never triggered since nothing set this
        // false before) — so this is the only line needed to wire it up.
        const requiresApproval = industryConfig?.industry_id === 'tea';
        return (0, db_1.withTransaction)(async (client) => {
            const tenantRes = await client.query(`INSERT INTO tenants (name, plan_type, billing_status, slug, is_active, created_at, metadata)
         VALUES ($1, 'free', 'active', $2, $3, NOW(), $4)
         RETURNING id, name, plan_type, slug`, [companyName, slug, !requiresApproval, JSON.stringify({ registration_source: source || 'app' })]);
            const tenant = tenantRes.rows[0];
            if (industryConfig) {
                await client.query(`INSERT INTO tenant_industries (tenant_id, industry_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [tenant.id, industryConfig.id]);
            }
            const storeRes = await client.query(`INSERT INTO stores (tenant_id, name, code, is_active, created_at)
         VALUES ($1, $2, $3, TRUE, NOW())
         RETURNING id`, [tenant.id, companyName, slug.substring(0, 10).toUpperCase()]);
            const store = storeRes.rows[0];
            const userRes = await client.query(`INSERT INTO users (tenant_id, store_id, email, phone, password_hash, role, first_name, last_name, is_active, is_email_verified, reg_type)
         VALUES ($1, $2, $3, $4, $5, 'owner', $6, $7, TRUE, FALSE, $8)
         RETURNING id, email, phone, role, tenant_id, store_id, first_name, last_name`, [tenant.id, store.id, resolvedEmail, phoneNorm, hashed, firstName || '', lastName || '', regType]);
            const user = userRes.rows[0];
            // Use the DB-resolved industry slug (industryConfig.industry_id), not the
            // raw request value — the raw value can be a UUID or other non-slug shape
            // depending on what the client sent, but industryConfig was already looked
            // up above by matching either the slug or the UUID, so it's authoritative.
            const industryKey = (0, default_categories_1.resolveCategoryKey)(industryConfig?.industry_id);
            const defaultCategories = default_categories_1.categoriesMap[industryKey] || [
                { name: "General", code: "GENERAL", desc: "Default category" }
            ];
            for (let i = 0; i < defaultCategories.length; i++) {
                const cat = defaultCategories[i];
                await client.query(`INSERT INTO categories (tenant_id, name, code, description, sort_order)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, name) DO NOTHING`, [tenant.id, cat.name, cat.code, cat.desc, i]);
            }
            const result = {
                tenant,
                store,
                user: { ...user, password_hash: undefined },
                industryLinked: !!industryConfig,
            };
            if (emailNorm) {
                (0, email_1.sendWelcomeEmail)(emailNorm, firstName || '', companyName).catch((e) => console.warn('[email] Welcome email failed:', e.message));
            }
            if (phoneNorm) {
                (0, whatsapp_1.sendRegistrationWhatsApp)(phoneNorm, firstName || '', companyName, tenant.plan_type).catch((e) => console.warn('[whatsapp] Registration message failed:', e.message));
            }
            return result;
        });
    }
}
exports.RegisterTenantCommandHandler = RegisterTenantCommandHandler;
