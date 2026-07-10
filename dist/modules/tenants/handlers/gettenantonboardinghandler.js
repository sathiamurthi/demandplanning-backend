"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetTenantOnboardingStatusHandler = void 0;
const db_1 = require("../../../config/db");
class GetTenantOnboardingStatusHandler {
    async execute(q) {
        const tenantId = q.tenantId;
        const hasIndustries = (await (0, db_1.query)(`SELECT 1 FROM tenant_industries WHERE tenant_id=$1 LIMIT 1`, [tenantId])).length > 0;
        const hasStoreConfig = (await (0, db_1.query)(`SELECT 1 FROM store_config sc
       JOIN tenant_industries ti ON sc.industry::uuid = ti.industry_id
       WHERE ti.tenant_id=$1 LIMIT 1`, [tenantId])).length > 0;
        const hasAdminUser = (await (0, db_1.query)(`SELECT 1 FROM users WHERE tenant_id=$1 AND role='owner' LIMIT 1`, [tenantId])).length > 0;
        return { hasIndustries, hasStoreConfig, hasAdminUser };
    }
}
exports.GetTenantOnboardingStatusHandler = GetTenantOnboardingStatusHandler;
