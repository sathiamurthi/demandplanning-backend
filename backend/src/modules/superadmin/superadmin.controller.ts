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
  try {
    const id = req.params.id as string;
    const result = await commandBus.execute<ApproveTenantCommand>({
      type: "superadmin.tenant.approve",
      tenantId: id,
    });
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function deactivateTenant(req: Request, res: Response) {
  try {
    const { id } = req.params;
    await dbQuery(`UPDATE tenants SET is_active=FALSE, billing_status='cancelled', updated_at=NOW() WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
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

// ── Ride360 Analytics ─────────────────────────────────────────

export async function getRide360Overview(_req: Request, res: Response) {
  try {
    const [
      [driversTotal], [customersTotal],
      [driversNew7d], [customersNew7d],
      [driversActive24h], [customersActive24h],
      [driversActive7d], [customersActive7d],
      [rideStats],
      [emptyTotal], [emptyLeads], [emptyConverted],
      [invitesTotal],
      aiUsage,
      [driversPaidPlan], [customersPaidPlan],
    ] = await Promise.all([
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM ride360_drivers`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM ride360_customers`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM ride360_drivers WHERE created_at >= NOW() - INTERVAL '7 days'`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM ride360_customers WHERE created_at >= NOW() - INTERVAL '7 days'`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM ride360_drivers WHERE last_login_at >= NOW() - INTERVAL '24 hours'`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM ride360_customers WHERE last_login_at >= NOW() - INTERVAL '24 hours'`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM ride360_drivers WHERE last_login_at >= NOW() - INTERVAL '7 days'`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM ride360_customers WHERE last_login_at >= NOW() - INTERVAL '7 days'`),
      dbQuery<any>(
        `SELECT COUNT(*) FILTER (WHERE kind='paid')::int AS paid_rides,
                COUNT(*) FILTER (WHERE kind='empty')::int AS empty_rides,
                COALESCE(SUM(fare) FILTER (WHERE kind='paid'),0)::float AS total_fare,
                COALESCE(SUM(piggy_contribution),0)::float AS total_piggy
         FROM ride360_rides WHERE status='completed'`
      ),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM ride360_rides WHERE kind='empty' AND status='completed'`),
      dbQuery<any>(`SELECT COUNT(DISTINCT origin_empty_ride_id)::int AS n FROM ride360_requests WHERE origin_empty_ride_id IS NOT NULL`),
      dbQuery<any>(`SELECT COUNT(DISTINCT origin_empty_ride_id)::int AS n FROM ride360_requests WHERE origin_empty_ride_id IS NOT NULL AND status='completed'`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM ride360_invites`),
      dbQuery<any>(`SELECT feature, COUNT(*)::int AS n FROM ride360_ai_usage GROUP BY feature ORDER BY n DESC`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM ride360_drivers WHERE subscription_plan != 'free'`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM ride360_customers WHERE subscription_plan != 'free'`),
    ]);

    res.json({
      success: true,
      data: {
        users: {
          driversTotal: driversTotal.n, customersTotal: customersTotal.n,
          driversNew7d: driversNew7d.n, customersNew7d: customersNew7d.n,
          driversActive24h: driversActive24h.n, customersActive24h: customersActive24h.n,
          driversActive7d: driversActive7d.n, customersActive7d: customersActive7d.n,
          driversPaidPlan: driversPaidPlan.n, customersPaidPlan: customersPaidPlan.n,
        },
        rides: {
          paidRides: rideStats.paid_rides, emptyRidesCompleted: rideStats.empty_rides,
          totalFare: rideStats.total_fare, totalPiggySaved: rideStats.total_piggy,
        },
        emptyRideConversion: {
          totalCompleted: emptyTotal.n, leadsGenerated: emptyLeads.n, converted: emptyConverted.n,
          conversionRatePct: emptyTotal.n > 0 ? Math.round((emptyConverted.n / emptyTotal.n) * 100) : 0,
        },
        invites: { total: invitesTotal.n },
        aiUsage,
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function listRide360Users(req: Request, res: Response) {
  try {
    const limit = Math.min(200, parseInt((req.query.limit as string) || "100"));
    const rows = await dbQuery<any>(
      `SELECT id, name, email, phone, 'driver' AS type, vehicle_type, subscription_plan, created_at, last_login_at
       FROM ride360_drivers
       UNION ALL
       SELECT id, NULL AS name, NULL AS email, phone, 'customer' AS type, NULL AS vehicle_type, subscription_plan, created_at, last_login_at
       FROM ride360_customers
       ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ success: true, data: rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function listRide360Invites(req: Request, res: Response) {
  try {
    const limit = Math.min(500, parseInt((req.query.limit as string) || "200"));
    const rows = await dbQuery<any>(
      `SELECT * FROM ride360_invites ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ success: true, data: rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function getRide360AIUsage(req: Request, res: Response) {
  try {
    const rows = await dbQuery<any>(
      `SELECT feature, DATE(created_at) AS day, COUNT(*)::int AS n
       FROM ride360_ai_usage GROUP BY feature, DATE(created_at) ORDER BY day DESC LIMIT 200`
    );
    res.json({ success: true, data: rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// ── SafeRide360 Analytics ─────────────────────────────────────
// Independent product from Ride360 (child-safety transport tracking vs.
// driver-marketplace ride-sharing) — separate tables, same reporting shape.

export async function getSafeRide360Overview(_req: Request, res: Response) {
  try {
    const [
      [orgsTotal], [driversTotal], [passengersTotal], [stopsTotal],
      [driversNew7d], [driversActive24h],
      [tripsTotal], [tripsActive], [tripsCompleted7d],
      [tpStats],
      [sosCount],
    ] = await Promise.all([
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM saferide360_organizations`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM saferide360_drivers`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM saferide360_passengers`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM saferide360_stops`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM saferide360_drivers WHERE created_at >= NOW() - INTERVAL '7 days'`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM saferide360_drivers WHERE last_login_at >= NOW() - INTERVAL '24 hours'`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM saferide360_trips`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM saferide360_trips WHERE status='active'`),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM saferide360_trips WHERE status='completed' AND actual_end_at >= NOW() - INTERVAL '7 days'`),
      dbQuery<any>(
        `SELECT COUNT(*) FILTER (WHERE status='picked')::int AS picked,
                COUNT(*) FILTER (WHERE status='absent')::int AS absent,
                COUNT(*) FILTER (WHERE status='pending')::int AS pending
         FROM saferide360_trip_passengers WHERE created_at >= NOW() - INTERVAL '7 days'`
      ),
      dbQuery<any>(`SELECT COUNT(*)::int AS n FROM saferide360_notifications WHERE type='sos' AND created_at >= NOW() - INTERVAL '7 days'`),
    ]);

    res.json({
      success: true,
      data: {
        organizations: orgsTotal.n,
        drivers: { total: driversTotal.n, new7d: driversNew7d.n, active24h: driversActive24h.n },
        passengers: passengersTotal.n,
        stops: stopsTotal.n,
        trips: { total: tripsTotal.n, active: tripsActive.n, completed7d: tripsCompleted7d.n },
        pickups7d: { picked: tpStats.picked, absent: tpStats.absent, pending: tpStats.pending },
        sos7d: sosCount.n,
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function listSafeRide360Organizations(req: Request, res: Response) {
  try {
    const limit = Math.min(200, parseInt((req.query.limit as string) || "100"));
    const rows = await dbQuery<any>(
      `SELECT o.*,
              (SELECT COUNT(*)::int FROM saferide360_drivers d WHERE d.organization_id=o.id) AS driver_count,
              (SELECT COUNT(*)::int FROM saferide360_passengers p WHERE p.organization_id=o.id) AS passenger_count
       FROM saferide360_organizations o ORDER BY o.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ success: true, data: rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// No live payment gateway is wired up for SafeRide360 (same reasoning as
// Data360's manual quota grant) — a package purchase is confirmed
// out-of-band, then the superadmin extends the organization's paid-up-until
// date here.
export async function activateSafeRide360Subscription(req: Request, res: Response) {
  try {
    const { organization_id, months } = req.body as { organization_id?: string; months?: number };
    if (!organization_id || !Number.isFinite(months) || (months as number) <= 0) {
      res.status(400).json({ success: false, error: "organization_id and a positive months are required" });
      return;
    }
    const [updated] = await dbQuery<any>(
      `UPDATE saferide360_organizations
       SET subscription_active_until = GREATEST(COALESCE(subscription_active_until, NOW()), NOW()) + ($1 || ' months')::interval
       WHERE id=$2 RETURNING id, name, subscription_active_until`,
      [months, organization_id]
    );
    if (!updated) { res.status(404).json({ success: false, error: "Organization not found" }); return; }
    res.json({ success: true, data: updated });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function listSafeRide360Trips(req: Request, res: Response) {
  try {
    const limit = Math.min(200, parseInt((req.query.limit as string) || "100"));
    const rows = await dbQuery<any>(
      `SELECT t.*, d.name AS driver_name, d.vehicle_number, o.name AS organization_name
       FROM saferide360_trips t
       JOIN saferide360_drivers d ON d.id = t.driver_id
       JOIN saferide360_organizations o ON o.id = t.organization_id
       ORDER BY t.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ success: true, data: rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// Router setup
const router = Router();

router.get("/tenants", getTenants);
router.post("/tenants/approve/:id", approveTenant);
router.post("/tenants/deactivate/:id", deactivateTenant);

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

// Ride360 analytics
router.get("/ride360/overview", getRide360Overview);
router.get("/ride360/users", listRide360Users);
router.get("/ride360/invites", listRide360Invites);
router.get("/ride360/ai-usage", getRide360AIUsage);

// SafeRide360 analytics
router.get("/saferide360/overview", getSafeRide360Overview);
router.get("/saferide360/organizations", listSafeRide360Organizations);
router.get("/saferide360/trips", listSafeRide360Trips);
router.post("/saferide360/activate-subscription", activateSafeRide360Subscription);

export default router;

// ── Platform Config CRUD ────────────────────────────────────────────────────
export async function getPlatformConfig(_req: Request, res: Response) {
  try {
    const rows = await dbQuery<any>('SELECT key, value FROM platform_config');
    const config: Record<string, any> = {};
    (rows || []).forEach((r: any) => { config[r.key] = r.value; });
    res.json({ success: true, data: config });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function setPlatformConfig(req: Request, res: Response) {
  try {
    const { key, value } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ success: false, error: 'key and value required' });
    }
    await dbQuery(
      `INSERT INTO platform_config (key, value, updated_at, updated_by)
       VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (key) DO UPDATE SET value=$2::jsonb, updated_at=NOW(), updated_by=$3`,
      [key, JSON.stringify(value), 'superadmin']
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}
