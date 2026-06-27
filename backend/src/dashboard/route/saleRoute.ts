// routes/salesRouter.ts
import { Router } from "express";
import { authMiddleware } from "../../modules/auth/auth.service";
import { requestLogger } from "../../modules/middleware/requestlogger";
import { queryBus } from "../../cqrs/queryBus";
import { commandBus } from "../../cqrs/commandBus";
import { GetSalesByStoreQuery } from "../queries/getsalesbystore";
import { CreateSaleHandler } from "../../handlers/createsalehandler";
import { GetSalesByStoreHandler } from "../../handlers/getsalesbystore";
import { CreateSaleCommand } from "../../commands/createsalecommand";


const salesRouter = Router({ mergeParams: true });

salesRouter.use(authMiddleware);
salesRouter.use(requestLogger);

// register query + command handlers
queryBus.register("sales.getByStore", new GetSalesByStoreHandler());
commandBus.register("sales.create", new CreateSaleHandler());

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

    const query = new GetSalesByStoreQuery(storeId);
    const data = await queryBus.execute(query);

    return res.json({ success: true, data });
  } catch (error) {
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

    const command = new CreateSaleCommand(tenantId, storeId, payload);
    const result = await commandBus.execute(command);

    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    console.error("Sales CQRS POST error:", error);
    return res.status(500).json({ success: false, message: "Failed to create sale" });
  }
});

export default salesRouter;
