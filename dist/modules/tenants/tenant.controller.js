"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const queryBus_1 = require("../../cqrs/queryBus");
const getdashboardquery_1 = require("./queries/getdashboardquery");
const router = (0, express_1.Router)();
router.get("/", async (req, res) => {
    const tenantId = req.user?.tenantId; // from auth middleware
    const data = await queryBus_1.queryBus.execute({ type: "tenant.dashboard.get", payload: new getdashboardquery_1.GetDashboardQuery(tenantId) });
    res.json({ success: true, data });
});
exports.default = router;
