import { Router } from "express";
import { queryBus } from "../../cqrs/queryBus";
import { GetDashboardQuery } from "./queries/getdashboardquery";
import { DashboardData } from "../../types";
import { GetTenantOnboardingStatusQuery } from "./queries/gettenantonboardingstatus";

const router = Router();

router.get("/", async (req, res) => {
  const tenantId = (req as any).user?.tenantId; // from auth middleware
  const data = await queryBus.execute<DashboardData>(
    { type: "tenant.dashboard.get", payload: new GetDashboardQuery(tenantId) }
  );
  res.json({ success: true, data });
});


export default router;
