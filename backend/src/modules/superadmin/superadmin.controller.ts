import { Request, Response, Router } from "express";
import { queryBus } from "../../cqrs/queryBus";
import { commandBus } from "../../cqrs/commandBus";
import { query as dbQuery } from "../../config/db";
import {
  getAIUsageSummary,
  getPipelineRuns,
  getPipelineRun,
  runAIPipeline,
} from "./ai-pipeline.service";

import {
  GetTenantsQuery,
  ApproveTenantCommand,
  GetUsersQuery,
  ChangePasswordCommand,
  SendNotificationCommand,
  SendMessageCommand,
  ManageSubscriptionCommand,
} from "./superadmin.service";

// Controller functions

export async function getTenants(req: Request, res: Response) {
  const result = await queryBus.execute<GetTenantsQuery>({
    type: "superadmin.tenants.get",
  });
  res.json(result);
}

export async function approveTenant(req: Request, res: Response) {
  const id = req.params.id as string;
  const result = await commandBus.execute<ApproveTenantCommand>({
    type: "superadmin.tenant.approve",
    tenantId: id,
  });
  res.json(result);
}

export async function getUsers(req: Request, res: Response) {
  try {
    const result = await queryBus.execute<GetUsersQuery>({
      type: "superadmin.users.get",
    });
    res.json({ success: true, data: result });
  } catch (err: any) {
    console.error("getUsers error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function changePassword(req: Request, res: Response) {
  const id = req.params.id as string;
  const { newPassword } = req.body;
  const result = await commandBus.execute<ChangePasswordCommand>({
    type: "superadmin.user.password.change",
    userId: id,
    newPassword,
  });
  res.json(result);
}

export async function sendNotification(req: Request, res: Response) {
  const { targetId, message } = req.body;
  const result = await commandBus.execute<SendNotificationCommand>({
    type: "superadmin.notification.send",
    targetId,
    message,
  });
  res.json(result);
}

export async function sendMessage(req: Request, res: Response) {
  const { senderId, receiverId, content } = req.body;
  const result = await commandBus.execute<SendMessageCommand>({
    type: "superadmin.message.send",
    senderId,
    receiverId,
    content,
  });
  res.json(result);
}

export async function manageSubscription(req: Request, res: Response) {
  const { tenantId, plan } = req.body;
  const result = await commandBus.execute<ManageSubscriptionCommand>({
    type: "superadmin.subscription.manage",
    tenantId,
    plan,
  });
  res.json(result);
}

// ── Explore Analytics ─────────────────────────────────────────

export async function getExploreStats(req: Request, res: Response) {
  try {
    const range = (req.query.range as string) || 'daily';
    let dateCond: string;
    if (range === 'weekly') dateCond = "session_date >= CURRENT_DATE - INTERVAL '7 days'";
    else if (range === 'monthly') dateCond = "session_date >= CURRENT_DATE - INTERVAL '30 days'";
    else dateCond = "session_date = CURRENT_DATE";

    const [[totalRow], [activeRow], sessions, topContrib] = await Promise.all([
      dbQuery<any>(`SELECT COUNT(*)::int AS total FROM explore_guests`),
      dbQuery<any>(`SELECT COUNT(*)::int AS active FROM explore_guests WHERE ${dateCond.replace('session_date','last_seen')}`),
      dbQuery<any>(
        `SELECT session_date::text AS date, COUNT(*)::int AS visits
         FROM explore_sessions WHERE ${dateCond}
         GROUP BY session_date ORDER BY session_date`
      ),
      dbQuery<any>(
        `SELECT guest_id, guest_name, listing_count, total_sessions, last_seen::text, is_active
         FROM explore_guests ORDER BY listing_count DESC, total_sessions DESC LIMIT 20`
      ),
    ]);

    res.json({ success: true, data: {
      total_guests: totalRow?.total || 0,
      active_guests: activeRow?.active || 0,
      sessions,
      top_contributors: topContrib,
    }});
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function listExploreGuests(req: Request, res: Response) {
  try {
    const { search = '', page = '1', limit = '50' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, parseInt(limit) || 50);
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = [];
    const vals: any[] = [];
    if (search) { conditions.push(`(guest_id ILIKE $1 OR guest_name ILIKE $1)`); vals.push(`%${search}%`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [[countRow], rows] = await Promise.all([
      dbQuery<any>(`SELECT COUNT(*)::int AS count FROM explore_guests ${where}`, vals),
      dbQuery<any>(
        `SELECT guest_id, guest_name, first_seen::text, last_seen::text,
                total_sessions, listing_count, is_active, deactivated_at::text, deactivated_by
         FROM explore_guests ${where}
         ORDER BY last_seen DESC
         LIMIT ${limitNum} OFFSET ${offset}`,
        vals
      ),
    ]);

    res.json({ success: true, data: rows, meta: { total: countRow?.count || 0, page: pageNum, limit: limitNum } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function deactivateExploreGuest(req: Request, res: Response) {
  try {
    const { guestId } = req.params;
    const deactivatedBy = (req as any).user?.email || 'superadmin';
    await dbQuery(
      `UPDATE explore_guests SET is_active = FALSE, deactivated_at = NOW(), deactivated_by = $2, updated_at = NOW()
       WHERE guest_id = $1`,
      [guestId, deactivatedBy]
    );
    res.json({ success: true, data: { deactivated: true } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function reactivateExploreGuest(req: Request, res: Response) {
  try {
    const { guestId } = req.params;
    await dbQuery(
      `UPDATE explore_guests SET is_active = TRUE, deactivated_at = NULL, deactivated_by = NULL, updated_at = NOW()
       WHERE guest_id = $1`,
      [guestId]
    );
    res.json({ success: true, data: { reactivated: true } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// ── AI Usage Report ───────────────────────────────────────────

export async function getAIUsageReport(req: Request, res: Response) {
  try {
    const range = ((req.query.range as string) || 'daily') as 'daily' | 'weekly' | 'monthly';
    const data = await getAIUsageSummary(range);
    res.json({ success: true, data });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// ── AI Pipeline ───────────────────────────────────────────────

export async function listPipelineRuns(req: Request, res: Response) {
  try {
    const limit = Math.min(50, parseInt((req.query.limit as string) || '20'));
    const runs = await getPipelineRuns(limit);
    res.json({ success: true, data: runs });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function getPipelineRunById(req: Request, res: Response) {
  try {
    const run = await getPipelineRun(req.params.runId as string);
    if (!run) { res.status(404).json({ success: false, error: 'Run not found' }); return; }
    res.json({ success: true, data: run });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function triggerPipelineRun(req: Request, res: Response) {
  try {
    const { storeId, storeName, tenantId } = req.body;
    if (!storeId || !tenantId) {
      res.status(400).json({ success: false, error: 'storeId and tenantId are required' });
      return;
    }
    const triggeredBy = (req as any).user?.id;
    const result = await runAIPipeline(storeId, storeName || 'Unknown Store', tenantId, triggeredBy);
    res.json({ success: true, data: result });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function getStoresForPipeline(req: Request, res: Response) {
  try {
    const stores = await dbQuery<any>(
      `SELECT s.id, s.name, s.city, t.id AS tenant_id, t.name AS tenant_name
       FROM stores s
       JOIN tenants t ON t.id = s.tenant_id
       WHERE s.is_active = TRUE
       ORDER BY t.name, s.name LIMIT 100`
    );
    res.json({ success: true, data: stores });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// Router setup
const router = Router();

router.get("/tenants", getTenants);
router.post("/tenants/approve/:id", approveTenant);

router.get("/users", getUsers);
router.patch("/users/:id/password", changePassword);

router.post("/notifications", sendNotification);
router.post("/messages", sendMessage);

router.post("/subscriptions", manageSubscription);

// Explore analytics
router.get("/explore/stats", getExploreStats);
router.get("/explore/guests", listExploreGuests);
router.post("/explore/guests/:guestId/deactivate", deactivateExploreGuest);
router.post("/explore/guests/:guestId/reactivate", reactivateExploreGuest);

// AI Usage report
router.get("/ai-usage", getAIUsageReport);

// AI Pipeline
router.get("/ai-pipeline/stores", getStoresForPipeline);
router.get("/ai-pipeline/runs", listPipelineRuns);
router.get("/ai-pipeline/runs/:runId", getPipelineRunById);
router.post("/ai-pipeline/run", triggerPipelineRun);

export default router;
