"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTenants = getTenants;
exports.approveTenant = approveTenant;
exports.deactivateTenant = deactivateTenant;
exports.listTeaGrowers = listTeaGrowers;
exports.activateTeaGrower = activateTeaGrower;
exports.deactivateTeaGrower = deactivateTeaGrower;
exports.getUsers = getUsers;
exports.activateUser = activateUser;
exports.deactivateUser = deactivateUser;
exports.changePassword = changePassword;
exports.sendNotification = sendNotification;
exports.sendMessage = sendMessage;
exports.manageSubscription = manageSubscription;
exports.getExploreStats = getExploreStats;
exports.listExploreGuests = listExploreGuests;
exports.deactivateExploreGuest = deactivateExploreGuest;
exports.reactivateExploreGuest = reactivateExploreGuest;
exports.getAIUsageReport = getAIUsageReport;
exports.listPipelineRuns = listPipelineRuns;
exports.getPipelineRunById = getPipelineRunById;
exports.triggerPipelineRun = triggerPipelineRun;
exports.getStoresForPipeline = getStoresForPipeline;
exports.getRide360Overview = getRide360Overview;
exports.listRide360Users = listRide360Users;
exports.listRide360Invites = listRide360Invites;
exports.getRide360AIUsage = getRide360AIUsage;
exports.getSafeRide360Overview = getSafeRide360Overview;
exports.listSafeRide360Organizations = listSafeRide360Organizations;
exports.activateSafeRide360Subscription = activateSafeRide360Subscription;
exports.listSafeRide360Trips = listSafeRide360Trips;
exports.listSafeRide360Drivers = listSafeRide360Drivers;
exports.listData360Users = listData360Users;
exports.setData360Plan = setData360Plan;
exports.listCollege360Users = listCollege360Users;
exports.setCollege360Plan = setCollege360Plan;
exports.getPlatformConfig = getPlatformConfig;
exports.setPlatformConfig = setPlatformConfig;
const express_1 = require("express");
const queryBus_1 = require("../../cqrs/queryBus");
const commandBus_1 = require("../../cqrs/commandBus");
const db_1 = require("../../config/db");
const email_1 = require("../../utils/email");
const whatsapp_1 = require("../../utils/whatsapp");
const ai_pipeline_service_1 = require("./ai-pipeline.service");
// Controller functions
async function getTenants(req, res) {
    const result = await queryBus_1.queryBus.execute({
        type: "superadmin.tenants.get",
    });
    res.json(result);
}
async function approveTenant(req, res) {
    try {
        const id = req.params.id;
        const result = await commandBus_1.commandBus.execute({
            type: "superadmin.tenant.approve",
            tenantId: id,
        });
        res.json({ success: true, data: result });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
async function deactivateTenant(req, res) {
    try {
        const { id } = req.params;
        await (0, db_1.query)(`UPDATE tenants SET is_active=FALSE, billing_status='cancelled', updated_at=NOW() WHERE id=$1`, [id]);
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
// ── TeaFactory360 growers — cross-tenant oversight ──────────────────
// Growers don't have their own account (their "login" is just a phone
// number an Agent/Factory already put on file — see grower-auth/login),
// so there's nothing to "approve" per se; is_active is the one lever
// that controls whether that phone number can still sign in.
async function listTeaGrowers(req, res) {
    try {
        const rows = await (0, db_1.query)(`SELECT g.id, g.name, g.grower_code, g.phone, g.is_active, g.created_at,
              t.id AS tenant_id, t.name AS tenant_name
       FROM tea_growers g
       JOIN tenants t ON t.id = g.tenant_id
       ORDER BY g.created_at DESC
       LIMIT 500`);
        res.json({ success: true, data: rows });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
async function activateTeaGrower(req, res) {
    try {
        const { id } = req.params;
        const rows = await (0, db_1.query)(`UPDATE tea_growers SET is_active=TRUE, updated_at=NOW() WHERE id=$1 RETURNING id`, [id]);
        if (!rows.length) {
            res.status(404).json({ success: false, error: "Grower not found" });
            return;
        }
        res.json({ success: true, data: { activated: true } });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
async function deactivateTeaGrower(req, res) {
    try {
        const { id } = req.params;
        const rows = await (0, db_1.query)(`UPDATE tea_growers SET is_active=FALSE, updated_at=NOW() WHERE id=$1 RETURNING id`, [id]);
        if (!rows.length) {
            res.status(404).json({ success: false, error: "Grower not found" });
            return;
        }
        res.json({ success: true, data: { deactivated: true } });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
async function getUsers(req, res) {
    try {
        const result = await queryBus_1.queryBus.execute({
            type: "superadmin.users.get",
        });
        res.json({ success: true, data: result });
    }
    catch (err) {
        console.error("getUsers error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
}
// Approve a pending self-registration (e.g. a TeaFactory360 agent) or
// re-enable a previously deactivated account — same underlying flag
// (users.is_active), covers both cases.
async function activateUser(req, res) {
    try {
        const id = req.params.id;
        const result = await commandBus_1.commandBus.execute({
            type: "superadmin.user.activate",
            userId: id,
        });
        res.json({ success: true, data: result });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
async function deactivateUser(req, res) {
    try {
        const id = req.params.id;
        const result = await commandBus_1.commandBus.execute({
            type: "superadmin.user.deactivate",
            userId: id,
        });
        res.json({ success: true, data: result });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
async function changePassword(req, res) {
    const id = req.params.id;
    const { newPassword } = req.body;
    const result = await commandBus_1.commandBus.execute({
        type: "superadmin.user.password.change",
        userId: id,
        newPassword,
    });
    res.json(result);
}
async function sendNotification(req, res) {
    const { targetId, message } = req.body;
    const result = await commandBus_1.commandBus.execute({
        type: "superadmin.notification.send",
        targetId,
        message,
    });
    res.json(result);
}
async function sendMessage(req, res) {
    const { senderId, receiverId, content } = req.body;
    const result = await commandBus_1.commandBus.execute({
        type: "superadmin.message.send",
        senderId,
        receiverId,
        content,
    });
    res.json(result);
}
async function manageSubscription(req, res) {
    const { tenantId, plan } = req.body;
    const result = await commandBus_1.commandBus.execute({
        type: "superadmin.subscription.manage",
        tenantId,
        plan,
    });
    res.json(result);
}
// ── Explore Analytics ─────────────────────────────────────────
async function getExploreStats(req, res) {
    try {
        const range = req.query.range || 'daily';
        let dateCond;
        if (range === 'weekly')
            dateCond = "session_date >= CURRENT_DATE - INTERVAL '7 days'";
        else if (range === 'monthly')
            dateCond = "session_date >= CURRENT_DATE - INTERVAL '30 days'";
        else
            dateCond = "session_date = CURRENT_DATE";
        const [[totalRow], [activeRow], sessions, topContrib] = await Promise.all([
            (0, db_1.query)(`SELECT COUNT(*)::int AS total FROM explore_guests`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS active FROM explore_guests WHERE ${dateCond.replace('session_date', 'last_seen')}`),
            (0, db_1.query)(`SELECT session_date::text AS date, COUNT(*)::int AS visits
         FROM explore_sessions WHERE ${dateCond}
         GROUP BY session_date ORDER BY session_date`),
            (0, db_1.query)(`SELECT guest_id, guest_name, listing_count, total_sessions, last_seen::text, is_active
         FROM explore_guests ORDER BY listing_count DESC, total_sessions DESC LIMIT 20`),
        ]);
        res.json({ success: true, data: {
                total_guests: totalRow?.total || 0,
                active_guests: activeRow?.active || 0,
                sessions,
                top_contributors: topContrib,
            } });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function listExploreGuests(req, res) {
    try {
        const { search = '', page = '1', limit = '50' } = req.query;
        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, parseInt(limit) || 50);
        const offset = (pageNum - 1) * limitNum;
        const conditions = [];
        const vals = [];
        if (search) {
            conditions.push(`(guest_id ILIKE $1 OR guest_name ILIKE $1)`);
            vals.push(`%${search}%`);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const [[countRow], rows] = await Promise.all([
            (0, db_1.query)(`SELECT COUNT(*)::int AS count FROM explore_guests ${where}`, vals),
            (0, db_1.query)(`SELECT guest_id, guest_name, first_seen::text, last_seen::text,
                total_sessions, listing_count, is_active, deactivated_at::text, deactivated_by
         FROM explore_guests ${where}
         ORDER BY last_seen DESC
         LIMIT ${limitNum} OFFSET ${offset}`, vals),
        ]);
        res.json({ success: true, data: rows, meta: { total: countRow?.count || 0, page: pageNum, limit: limitNum } });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function deactivateExploreGuest(req, res) {
    try {
        const { guestId } = req.params;
        const deactivatedBy = req.user?.email || 'superadmin';
        await (0, db_1.query)(`UPDATE explore_guests SET is_active = FALSE, deactivated_at = NOW(), deactivated_by = $2, updated_at = NOW()
       WHERE guest_id = $1`, [guestId, deactivatedBy]);
        res.json({ success: true, data: { deactivated: true } });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function reactivateExploreGuest(req, res) {
    try {
        const { guestId } = req.params;
        await (0, db_1.query)(`UPDATE explore_guests SET is_active = TRUE, deactivated_at = NULL, deactivated_by = NULL, updated_at = NOW()
       WHERE guest_id = $1`, [guestId]);
        res.json({ success: true, data: { reactivated: true } });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
// ── AI Usage Report ───────────────────────────────────────────
async function getAIUsageReport(req, res) {
    try {
        const range = (req.query.range || 'daily');
        const data = await (0, ai_pipeline_service_1.getAIUsageSummary)(range);
        res.json({ success: true, data });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
// ── AI Pipeline ───────────────────────────────────────────────
async function listPipelineRuns(req, res) {
    try {
        const limit = Math.min(50, parseInt(req.query.limit || '20'));
        const runs = await (0, ai_pipeline_service_1.getPipelineRuns)(limit);
        res.json({ success: true, data: runs });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function getPipelineRunById(req, res) {
    try {
        const run = await (0, ai_pipeline_service_1.getPipelineRun)(req.params.runId);
        if (!run) {
            res.status(404).json({ success: false, error: 'Run not found' });
            return;
        }
        res.json({ success: true, data: run });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function triggerPipelineRun(req, res) {
    try {
        const { storeId, storeName, tenantId } = req.body;
        if (!storeId || !tenantId) {
            res.status(400).json({ success: false, error: 'storeId and tenantId are required' });
            return;
        }
        const triggeredBy = req.user?.id;
        const result = await (0, ai_pipeline_service_1.runAIPipeline)(storeId, storeName || 'Unknown Store', tenantId, triggeredBy);
        res.json({ success: true, data: result });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function getStoresForPipeline(req, res) {
    try {
        const stores = await (0, db_1.query)(`SELECT s.id, s.name, s.city, t.id AS tenant_id, t.name AS tenant_name
       FROM stores s
       JOIN tenants t ON t.id = s.tenant_id
       WHERE s.is_active = TRUE
       ORDER BY t.name, s.name LIMIT 100`);
        res.json({ success: true, data: stores });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
// ── Ride360 Analytics ─────────────────────────────────────────
async function getRide360Overview(_req, res) {
    try {
        const [[driversTotal], [customersTotal], [driversNew7d], [customersNew7d], [driversActive24h], [customersActive24h], [driversActive7d], [customersActive7d], [rideStats], [emptyTotal], [emptyLeads], [emptyConverted], [invitesTotal], aiUsage, [driversPaidPlan], [customersPaidPlan],] = await Promise.all([
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM ride360_drivers`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM ride360_customers`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM ride360_drivers WHERE created_at >= NOW() - INTERVAL '7 days'`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM ride360_customers WHERE created_at >= NOW() - INTERVAL '7 days'`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM ride360_drivers WHERE last_login_at >= NOW() - INTERVAL '24 hours'`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM ride360_customers WHERE last_login_at >= NOW() - INTERVAL '24 hours'`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM ride360_drivers WHERE last_login_at >= NOW() - INTERVAL '7 days'`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM ride360_customers WHERE last_login_at >= NOW() - INTERVAL '7 days'`),
            (0, db_1.query)(`SELECT COUNT(*) FILTER (WHERE kind='paid')::int AS paid_rides,
                COUNT(*) FILTER (WHERE kind='empty')::int AS empty_rides,
                COALESCE(SUM(fare) FILTER (WHERE kind='paid'),0)::float AS total_fare,
                COALESCE(SUM(piggy_contribution),0)::float AS total_piggy
         FROM ride360_rides WHERE status='completed'`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM ride360_rides WHERE kind='empty' AND status='completed'`),
            (0, db_1.query)(`SELECT COUNT(DISTINCT origin_empty_ride_id)::int AS n FROM ride360_requests WHERE origin_empty_ride_id IS NOT NULL`),
            (0, db_1.query)(`SELECT COUNT(DISTINCT origin_empty_ride_id)::int AS n FROM ride360_requests WHERE origin_empty_ride_id IS NOT NULL AND status='completed'`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM ride360_invites`),
            (0, db_1.query)(`SELECT feature, COUNT(*)::int AS n FROM ride360_ai_usage GROUP BY feature ORDER BY n DESC`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM ride360_drivers WHERE subscription_plan != 'free'`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM ride360_customers WHERE subscription_plan != 'free'`),
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
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function listRide360Users(req, res) {
    try {
        const limit = Math.min(200, parseInt(req.query.limit || "100"));
        const rows = await (0, db_1.query)(`SELECT id, name, email, phone, 'driver' AS type, vehicle_type, subscription_plan, created_at, last_login_at, is_active
       FROM ride360_drivers
       UNION ALL
       SELECT id, NULL AS name, NULL AS email, phone, 'customer' AS type, NULL AS vehicle_type, subscription_plan, created_at, last_login_at, is_active
       FROM ride360_customers
       ORDER BY created_at DESC LIMIT $1`, [limit]);
        res.json({ success: true, data: rows });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function listRide360Invites(req, res) {
    try {
        const limit = Math.min(500, parseInt(req.query.limit || "200"));
        const rows = await (0, db_1.query)(`SELECT * FROM ride360_invites ORDER BY created_at DESC LIMIT $1`, [limit]);
        res.json({ success: true, data: rows });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function getRide360AIUsage(req, res) {
    try {
        const rows = await (0, db_1.query)(`SELECT feature, DATE(created_at) AS day, COUNT(*)::int AS n
       FROM ride360_ai_usage GROUP BY feature, DATE(created_at) ORDER BY day DESC LIMIT 200`);
        res.json({ success: true, data: rows });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
// ── SafeRide360 Analytics ─────────────────────────────────────
// Independent product from Ride360 (child-safety transport tracking vs.
// driver-marketplace ride-sharing) — separate tables, same reporting shape.
async function getSafeRide360Overview(_req, res) {
    try {
        const [[orgsTotal], [driversTotal], [passengersTotal], [stopsTotal], [driversNew7d], [driversActive24h], [tripsTotal], [tripsActive], [tripsCompleted7d], [tpStats], [sosCount],] = await Promise.all([
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM saferide360_organizations`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM saferide360_drivers`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM saferide360_passengers`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM saferide360_stops`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM saferide360_drivers WHERE created_at >= NOW() - INTERVAL '7 days'`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM saferide360_drivers WHERE last_login_at >= NOW() - INTERVAL '24 hours'`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM saferide360_trips`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM saferide360_trips WHERE status='active'`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM saferide360_trips WHERE status='completed' AND actual_end_at >= NOW() - INTERVAL '7 days'`),
            (0, db_1.query)(`SELECT COUNT(*) FILTER (WHERE status='picked')::int AS picked,
                COUNT(*) FILTER (WHERE status='absent')::int AS absent,
                COUNT(*) FILTER (WHERE status='pending')::int AS pending
         FROM saferide360_trip_passengers WHERE created_at >= NOW() - INTERVAL '7 days'`),
            (0, db_1.query)(`SELECT COUNT(*)::int AS n FROM saferide360_notifications WHERE type='sos' AND created_at >= NOW() - INTERVAL '7 days'`),
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
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function listSafeRide360Organizations(req, res) {
    try {
        const limit = Math.min(200, parseInt(req.query.limit || "100"));
        const rows = await (0, db_1.query)(`SELECT o.*,
              (SELECT COUNT(*)::int FROM saferide360_drivers d WHERE d.organization_id=o.id) AS driver_count,
              (SELECT COUNT(*)::int FROM saferide360_passengers p WHERE p.organization_id=o.id) AS passenger_count
       FROM saferide360_organizations o ORDER BY o.created_at DESC LIMIT $1`, [limit]);
        res.json({ success: true, data: rows });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
// No live payment gateway is wired up for SafeRide360 (same reasoning as
// Data360's manual quota grant) — a package purchase is confirmed
// out-of-band, then the superadmin extends the organization's paid-up-until
// date here.
async function activateSafeRide360Subscription(req, res) {
    try {
        const { organization_id, months } = req.body;
        if (!organization_id || !Number.isFinite(months) || months <= 0) {
            res.status(400).json({ success: false, error: "organization_id and a positive months are required" });
            return;
        }
        const [updated] = await (0, db_1.query)(`UPDATE saferide360_organizations
       SET subscription_active_until = GREATEST(COALESCE(subscription_active_until, NOW()), NOW()) + ($1 || ' months')::interval
       WHERE id=$2 RETURNING id, name, subscription_active_until`, [months, organization_id]);
        if (!updated) {
            res.status(404).json({ success: false, error: "Organization not found" });
            return;
        }
        res.json({ success: true, data: updated });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function listSafeRide360Trips(req, res) {
    try {
        const limit = Math.min(200, parseInt(req.query.limit || "100"));
        const rows = await (0, db_1.query)(`SELECT t.*, d.name AS driver_name, d.vehicle_number, o.name AS organization_name
       FROM saferide360_trips t
       JOIN saferide360_drivers d ON d.id = t.driver_id
       JOIN saferide360_organizations o ON o.id = t.organization_id
       ORDER BY t.created_at DESC LIMIT $1`, [limit]);
        res.json({ success: true, data: rows });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function listSafeRide360Drivers(req, res) {
    try {
        const limit = Math.min(200, parseInt(req.query.limit || "100"));
        const rows = await (0, db_1.query)(`SELECT d.*, o.name AS organization_name
       FROM saferide360_drivers d JOIN saferide360_organizations o ON o.id = d.organization_id
       ORDER BY d.created_at DESC LIMIT $1`, [limit]);
        res.json({ success: true, data: rows });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function listData360Users(req, res) {
    try {
        const limit = Math.min(200, parseInt(req.query.limit || "100"));
        const rows = await (0, db_1.query)(`SELECT id, name, email, phone, role, is_active, is_paid AS premium, preferences, purchased_document_quota, created_at
       FROM data360_users ORDER BY created_at DESC LIMIT $1`, [limit]);
        res.json({ success: true, data: rows });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function setData360Plan(req, res) {
    try {
        const premium = req.body?.premium === true;
        const [row] = await (0, db_1.query)(`UPDATE data360_users SET is_paid=$1 WHERE id=$2 RETURNING id, email, is_paid AS premium`, [premium, req.params.id]);
        if (!row) {
            res.status(404).json({ success: false, error: "Data360 user not found" });
            return;
        }
        res.json({ success: true, data: row });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function listCollege360Users(req, res) {
    try {
        const limit = Math.min(200, parseInt(req.query.limit || "100"));
        const rows = await (0, db_1.query)(`SELECT id, name, email, phone, role, college, premium, is_active, created_at
       FROM c360_users ORDER BY created_at DESC LIMIT $1`, [limit]);
        res.json({ success: true, data: rows });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
async function setCollege360Plan(req, res) {
    try {
        const premium = req.body?.premium === true;
        const [row] = await (0, db_1.query)(`UPDATE c360_users SET premium=$1 WHERE id=$2 RETURNING id, email, premium`, [premium, req.params.id]);
        if (!row) {
            res.status(404).json({ success: false, error: "College360 user not found" });
            return;
        }
        res.json({ success: true, data: row });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
function makeSuspendReactivate(cfg) {
    const suspend = async (req, res) => {
        try {
            const { id } = req.params;
            const deactivatedBy = req.user?.email || "superadmin";
            const rows = await (0, db_1.query)(`UPDATE ${cfg.table} SET is_active = FALSE, deactivated_at = NOW(), deactivated_by = $2 WHERE id = $1 RETURNING id`, [id, deactivatedBy]);
            if (!rows.length) {
                res.status(404).json({ success: false, error: "Account not found" });
                return;
            }
            res.json({ success: true, data: { suspended: true } });
        }
        catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    };
    const reactivate = async (req, res) => {
        try {
            const { id } = req.params;
            const rows = await (0, db_1.query)(`UPDATE ${cfg.table} SET is_active = TRUE, deactivated_at = NULL, deactivated_by = NULL WHERE id = $1 RETURNING id`, [id]);
            if (!rows.length) {
                res.status(404).json({ success: false, error: "Account not found" });
                return;
            }
            res.json({ success: true, data: { reactivated: true } });
        }
        catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    };
    const sendReminder = async (req, res) => {
        try {
            const { id } = req.params;
            const { message } = req.body;
            const cols = ["id", cfg.nameCol, cfg.phoneCol, cfg.emailCol].filter(Boolean).join(", ");
            const account = await (0, db_1.queryOne)(`SELECT ${cols} FROM ${cfg.table} WHERE id=$1`, [id]);
            if (!account) {
                res.status(404).json({ success: false, error: "Account not found" });
                return;
            }
            const name = cfg.nameCol ? account[cfg.nameCol] : null;
            const greeting = name ? `Hi ${name},` : "Hi,";
            const body = message?.trim() || "This is a reminder that payment is due on your account. Please renew to avoid any interruption in service.";
            const text = `${greeting}\n\n${body}\n\n— DemandGeniusAI`;
            let channel = null;
            if (cfg.phoneCol && account[cfg.phoneCol]) {
                await (0, whatsapp_1.sendWhatsAppText)(account[cfg.phoneCol], text);
                channel = "whatsapp";
            }
            else if (cfg.emailCol && account[cfg.emailCol]) {
                await (0, email_1.sendMail)({ to: account[cfg.emailCol], subject: "Payment Reminder — DemandGeniusAI", html: `<p>${text.replace(/\n/g, "<br/>")}</p>` });
                channel = "email";
            }
            if (!channel) {
                res.status(400).json({ success: false, error: "This account has no phone or email on file to send a reminder to" });
                return;
            }
            res.json({ success: true, data: { sent: true, channel } });
        }
        catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    };
    return { suspend, reactivate, sendReminder };
}
const data360Accounts = makeSuspendReactivate({ table: "data360_users", nameCol: "name", phoneCol: null, emailCol: "email" });
const ride360Drivers = makeSuspendReactivate({ table: "ride360_drivers", nameCol: "name", phoneCol: "phone", emailCol: "email" });
const ride360Customers = makeSuspendReactivate({ table: "ride360_customers", nameCol: null, phoneCol: "phone", emailCol: null });
const saferide360Drivers = makeSuspendReactivate({ table: "saferide360_drivers", nameCol: "name", phoneCol: "phone", emailCol: null });
const college360Accounts = makeSuspendReactivate({ table: "c360_users", nameCol: "name", phoneCol: "phone", emailCol: "email" });
// Router setup
const router = (0, express_1.Router)();
router.get("/tenants", getTenants);
router.post("/tenants/approve/:id", approveTenant);
router.post("/tenants/deactivate/:id", deactivateTenant);
router.get("/tea/growers", listTeaGrowers);
router.post("/tea/growers/:id/activate", activateTeaGrower);
router.post("/tea/growers/:id/deactivate", deactivateTeaGrower);
router.get("/users", getUsers);
router.patch("/users/:id/password", changePassword);
router.post("/users/:id/activate", activateUser);
router.post("/users/:id/deactivate", deactivateUser);
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
router.get("/saferide360/drivers", listSafeRide360Drivers);
router.get("/data360/users", listData360Users);
router.get("/college360/users", listCollege360Users);
router.post("/saferide360/activate-subscription", activateSafeRide360Subscription);
// Account suspension + payment reminders — every app except the main
// enterprise/tenant store (tenants have their own approve/deactivate flow
// above).
router.post("/data360/users/:id/suspend", data360Accounts.suspend);
router.post("/data360/users/:id/reactivate", data360Accounts.reactivate);
router.post("/data360/users/:id/send-reminder", data360Accounts.sendReminder);
router.post("/data360/users/:id/plan", setData360Plan);
router.post("/ride360/drivers/:id/suspend", ride360Drivers.suspend);
router.post("/ride360/drivers/:id/reactivate", ride360Drivers.reactivate);
router.post("/ride360/drivers/:id/send-reminder", ride360Drivers.sendReminder);
router.post("/ride360/customers/:id/suspend", ride360Customers.suspend);
router.post("/ride360/customers/:id/reactivate", ride360Customers.reactivate);
router.post("/ride360/customers/:id/send-reminder", ride360Customers.sendReminder);
router.post("/saferide360/drivers/:id/suspend", saferide360Drivers.suspend);
router.post("/saferide360/drivers/:id/reactivate", saferide360Drivers.reactivate);
router.post("/saferide360/drivers/:id/send-reminder", saferide360Drivers.sendReminder);
router.post("/college360/users/:id/suspend", college360Accounts.suspend);
router.post("/college360/users/:id/reactivate", college360Accounts.reactivate);
router.post("/college360/users/:id/send-reminder", college360Accounts.sendReminder);
router.post("/college360/users/:id/plan", setCollege360Plan);
exports.default = router;
// ── Platform Config CRUD ────────────────────────────────────────────────────
async function getPlatformConfig(_req, res) {
    try {
        const rows = await (0, db_1.query)('SELECT key, value FROM platform_config');
        const config = {};
        (rows || []).forEach((r) => { config[r.key] = r.value; });
        res.json({ success: true, data: config });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
async function setPlatformConfig(req, res) {
    try {
        const { key, value } = req.body;
        if (!key || value === undefined) {
            return res.status(400).json({ success: false, error: 'key and value required' });
        }
        await (0, db_1.query)(`INSERT INTO platform_config (key, value, updated_at, updated_by)
       VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (key) DO UPDATE SET value=$2::jsonb, updated_at=NOW(), updated_by=$3`, [key, JSON.stringify(value), 'superadmin']);
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
