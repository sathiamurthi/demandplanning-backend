"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const tenant_service_1 = require("./handlers/tenant.service");
const getdashboardqueryhandler_1 = require("./handlers/getdashboardqueryhandler");
const auth_service_1 = require("../auth/auth.service");
const gettenantonboardingstatus_1 = require("./queries/gettenantonboardingstatus");
const queryBus_1 = require("../../cqrs/queryBus");
const tenantsRouter = (0, express_1.Router)();
tenantsRouter.use(auth_service_1.authMiddleware);
// -----------------------------
// GET all tenants (superadmin)
// -----------------------------
tenantsRouter.get("/superadmin/tenants", async (req, res) => {
    try {
        const tenants = await (0, tenant_service_1.getTenantsService)();
        res.json({ success: true, data: tenants });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// -----------------------------
// GET tenant dashboard
// -----------------------------
tenantsRouter.get("/", async (req, res) => {
    try {
        // tenantId should come from auth middleware/session
        const tenantId = req.params.tenantId || req.user?.tenantId;
        if (!tenantId) {
            return res.status(400).json({ success: false, error: "tenantId required" });
        }
        const dashboard = await (0, getdashboardqueryhandler_1.getDashboardService)(tenantId);
        res.json({ success: true, data: dashboard });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
tenantsRouter.get("/onboarding-status", async (req, res) => {
    try {
        const tenantId = req.params.tenantId || req.user?.tenantId;
        if (!tenantId) {
            return res.status(400).json({ success: false, error: "tenantId required" });
        }
        const data = await queryBus_1.queryBus.execute({
            type: "tenant.onboarding.get",
            payload: new gettenantonboardingstatus_1.GetTenantOnboardingStatusQuery(tenantId),
        });
        res.json({ success: true, data });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
exports.default = tenantsRouter;
