"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// routes/salesRouter.ts
const express_1 = require("express");
const auth_service_1 = require("../../modules/auth/auth.service");
const requestlogger_1 = require("../../modules/middleware/requestlogger");
const queryBus_1 = require("../../cqrs/queryBus");
const commandBus_1 = require("../../cqrs/commandBus");
const getsalesbystore_1 = require("../queries/getsalesbystore");
const createsalehandler_1 = require("../../handlers/createsalehandler");
const getsalesbystore_2 = require("../../handlers/getsalesbystore");
const createsalecommand_1 = require("../../commands/createsalecommand");
const salesRouter = (0, express_1.Router)({ mergeParams: true });
salesRouter.use(auth_service_1.authMiddleware);
salesRouter.use(requestlogger_1.requestLogger);
// register query + command handlers
queryBus_1.queryBus.register("sales.getByStore", new getsalesbystore_2.GetSalesByStoreHandler());
commandBus_1.commandBus.register("sales.create", new createsalehandler_1.CreateSaleHandler());
/**
 * GET /api/stores/:storeId/sales
 * Fetch sales for a store
 */
salesRouter.get("/:storeId/sales", async (req, res) => {
    try {
        const { storeId } = req.params;
        if (!storeId) {
            return res.status(400).json({ success: false, message: "storeId is required" });
        }
        const query = new getsalesbystore_1.GetSalesByStoreQuery(storeId);
        const data = await queryBus_1.queryBus.execute(query);
        return res.json({ success: true, data });
    }
    catch (error) {
        console.error("Sales CQRS GET error:", error);
        return res.status(500).json({ success: false, message: "Failed to load sales" });
    }
});
/**
 * POST /api/stores/:storeId/sales
 * Create a new sale
 */
salesRouter.post("/:storeId/sales", async (req, res) => {
    try {
        const { storeId } = req.params;
        const tenantId = req.user?.tenantId; // assuming authMiddleware attaches tenantId
        const payload = req.body;
        if (!storeId || !tenantId) {
            return res.status(400).json({ success: false, message: "storeId and tenantId are required" });
        }
        const command = new createsalecommand_1.CreateSaleCommand(tenantId, storeId, payload);
        const result = await commandBus_1.commandBus.execute(command);
        return res.status(201).json({ success: true, data: result });
    }
    catch (error) {
        console.error("Sales CQRS POST error:", error);
        return res.status(500).json({ success: false, message: "Failed to create sale" });
    }
});
exports.default = salesRouter;
