import { Router } from "express";
import { getTenantsService } from "./handlers/tenant.service";
import { getDashboardService } from "./handlers/getdashboardqueryhandler";
import { authMiddleware } from '../auth/auth.service';
import { Request } from "express";
import { GetTenantOnboardingStatusQuery } from "./queries/gettenantonboardingstatus";
import { queryBus } from "../../cqrs/queryBus";
const tenantsRouter = Router();
tenantsRouter.use(authMiddleware);

// -----------------------------
// GET all tenants (superadmin)
// -----------------------------
tenantsRouter.get("/superadmin/tenants", async (req, res) => {
  try {
    const tenants = await getTenantsService();
    res.json({ success: true, data: tenants });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------
// GET tenant dashboard
// -----------------------------
tenantsRouter.get("/", async (req: Request<{ tenantId: string }>, res) => {
  try {
    // tenantId should come from auth middleware/session
    const tenantId = req.params.tenantId || req.user?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, error: "tenantId required" });
    }
    const dashboard = await getDashboardService(tenantId);
    res.json({ success: true, data: dashboard });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

tenantsRouter.get("/onboarding-status", async  (req: Request<{ tenantId: string }>, res) => {
  try {
    const tenantId = req.params.tenantId || req.user?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, error: "tenantId required" });
    }

    const data = await queryBus.execute({
      type: "tenant.onboarding.get",
      payload: new GetTenantOnboardingStatusQuery(tenantId),
    });

    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default tenantsRouter;
