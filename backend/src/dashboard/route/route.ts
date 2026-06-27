import { GetDashboardQuery } from "./../queries/getdashboard.query";
import { queryBus } from "../../cqrs/queryBus";


import { Router } from "express";
import { authMiddleware } from "../../modules/auth/auth.service";
import { GetDashboardHandler } from "../queries/getdashboard.handler";
import { requireTenantAccess } from "../../core/guards/roleGuard";
import { requestLogger } from "../../modules/middleware/requestlogger";

const dashboardRouter = Router({ mergeParams: true });
dashboardRouter.use(requestLogger);

queryBus.register('dashbaord.query',     new GetDashboardHandler());
/**
 * GET /api/dashboard/:storeId
 */
dashboardRouter.get("/:storeId/dashboard", authMiddleware, async (req, res) => {
  try {
    const storeId = req.params.storeId as string;
    if (!storeId) {
      return res.status(400).json({
        success: false,
        message: "storeId is required",
      });
    }

    const query = new GetDashboardQuery(storeId);

    const data = await queryBus.execute(query);

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Dashboard CQRS error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load dashboard",
    });
  }
});

export default dashboardRouter;