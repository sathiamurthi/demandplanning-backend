"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const getdashboard_query_1 = require("./../queries/getdashboard.query");
const queryBus_1 = require("../../cqrs/queryBus");
const express_1 = require("express");
const auth_service_1 = require("../../modules/auth/auth.service");
const getdashboard_handler_1 = require("../queries/getdashboard.handler");
const requestlogger_1 = require("../../modules/middleware/requestlogger");
const dashboardRouter = (0, express_1.Router)({ mergeParams: true });
dashboardRouter.use(requestlogger_1.requestLogger);
queryBus_1.queryBus.register('dashbaord.query', new getdashboard_handler_1.GetDashboardHandler());
/**
 * GET /api/dashboard/:storeId
 */
dashboardRouter.get("/:storeId/dashboard", auth_service_1.authMiddleware, async (req, res) => {
    try {
        const storeId = req.params.storeId;
        if (!storeId) {
            return res.status(400).json({
                success: false,
                message: "storeId is required",
            });
        }
        const query = new getdashboard_query_1.GetDashboardQuery(storeId);
        const data = await queryBus_1.queryBus.execute(query);
        return res.json({
            success: true,
            data,
        });
    }
    catch (error) {
        console.error("Dashboard CQRS error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to load dashboard",
        });
    }
});
exports.default = dashboardRouter;
