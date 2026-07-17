"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saferide360Router = void 0;
exports.runSafeRide360LocationUpdateJob = runSafeRide360LocationUpdateJob;
exports.runSafeRide360RetentionJob = runSafeRide360RetentionJob;
// ============================================================
// saferide360.router.ts — SafeRide360 API (child-safety-first transport
// tracking; first vertical is school pickup/drop, schema uses generic
// nouns — organization/passenger/guardian/stop — so future verticals
// reuse it untouched).
// Mounted at /v1/saferide360 in app.ts
// Auth: own JWT scope='saferide360', role='driver'|'guardian', same
// secret as the rest of the backend. Fully isolated from ride360_* — a
// different product (driver-marketplace ride-sharing vs. fixed-route
// transport tracking for children/passengers).
// ============================================================
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = require("../../config/db");
const whatsapp_1 = require("../../utils/whatsapp");
const logger_1 = require("../../config/logger");
exports.saferide360Router = (0, express_1.Router)();
// ── Config ───────────────────────────────────────────────────
const JWT_SECRET = (process.env.JWT_SECRET || 'dev-secret-change-this');
const driverSignOptions = { expiresIn: 30 * 24 * 3600 }; // 30 days, matches Ride360's driver session length
const guardianSignOptions = { expiresIn: 24 * 3600 }; // 1 day — re-verify via OTP daily, lower-stakes to re-auth
// ── Helpers ──────────────────────────────────────────────────
function ok(res, data, status = 200) {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res, message, status = 400) {
    res.status(status).json({ success: false, error: message, timestamp: new Date().toISOString() });
}
function srAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(header.slice(7), JWT_SECRET);
        if (decoded.scope !== 'saferide360') {
            res.status(403).json({ success: false, error: 'Forbidden' });
            return;
        }
        req.srUser = { sub: decoded.sub, role: decoded.role };
        next();
    }
    catch {
        res.status(401).json({ success: false, error: 'Token expired or invalid' });
    }
}
function requireDriver(req, res, next) {
    if (req.srUser?.role !== 'driver') {
        res.status(403).json({ success: false, error: 'Driver account required' });
        return;
    }
    next();
}
function requireGuardian(req, res, next) {
    if (req.srUser?.role !== 'guardian') {
        res.status(403).json({ success: false, error: 'Guardian account required' });
        return;
    }
    next();
}
// ── Row -> frontend-shape mappers ─────────────────────────────
function mapOrg(row) {
    return {
        id: row.id, name: row.name, orgType: row.org_type, createdAt: row.created_at,
        trialEndsAt: row.trial_ends_at, subscriptionActiveUntil: row.subscription_active_until || undefined,
        planRateInrPerPassenger: row.plan_rate_inr_per_passenger,
    };
}
// Package plan: INR 100/passenger/month by default (per-org, in case a
// future negotiated rate differs). Active if still inside the trial
// window OR paid up (subscription_active_until in the future).
function isSubscriptionActive(org) {
    const now = Date.now();
    if (org.trial_ends_at && new Date(org.trial_ends_at).getTime() > now)
        return true;
    if (org.subscription_active_until && new Date(org.subscription_active_until).getTime() > now)
        return true;
    return false;
}
function mapDriver(row) {
    return { id: row.id, organizationId: row.organization_id, name: row.name, phone: row.phone, vehicleNumber: row.vehicle_number, vehicleType: row.vehicle_type, createdAt: row.created_at };
}
function mapStop(row) {
    return { id: row.id, organizationId: row.organization_id, name: row.name, lat: Number(row.lat), lng: Number(row.lng), sequence: row.sequence };
}
function mapPassenger(row) {
    return {
        id: row.id, organizationId: row.organization_id, name: row.name,
        guardianName: row.guardian_name, guardianPhone: row.guardian_phone,
        pickupStopId: row.pickup_stop_id || undefined, dropStopId: row.drop_stop_id || undefined,
        schoolName: row.school_name || undefined,
    };
}
function mapTrip(row) {
    return {
        id: row.id, organizationId: row.organization_id, driverId: row.driver_id, name: row.name,
        direction: row.direction, scheduledStartTime: row.scheduled_start_time, scheduledEndTime: row.scheduled_end_time,
        status: row.status, actualStartAt: row.actual_start_at || undefined, actualEndAt: row.actual_end_at || undefined,
        liveLat: row.live_lat != null ? Number(row.live_lat) : undefined,
        liveLng: row.live_lng != null ? Number(row.live_lng) : undefined,
        liveUpdatedAt: row.live_updated_at || undefined,
        templateId: row.template_id || undefined,
    };
}
function mapTripTemplate(row) {
    return { id: row.id, organizationId: row.organization_id, name: row.name, passengerIds: row.passenger_ids || [], createdAt: row.created_at };
}
function mapTripPassenger(row) {
    return { id: row.id, tripId: row.trip_id, passengerId: row.passenger_id, status: row.status, pickedAt: row.picked_at || undefined };
}
function mapNotification(row) {
    return { id: row.id, guardianPhone: row.guardian_phone, tripId: row.trip_id || undefined, passengerId: row.passenger_id || undefined, type: row.type, text: row.text, read: row.read, createdAt: row.created_at };
}
async function pushGuardianNotif(guardianPhone, type, text, tripId, passengerId) {
    await (0, db_1.query)(`INSERT INTO saferide360_notifications (guardian_phone, trip_id, passenger_id, type, text) VALUES ($1,$2,$3,$4,$5)`, [guardianPhone, tripId || null, passengerId || null, type, text]);
    // Best-effort — a guardian without WhatsApp configured server-side still
    // gets the in-app notification row above; this just adds real delivery
    // when ENABLE_WHATSAPP is on.
    try {
        const result = await (0, whatsapp_1.sendWhatsAppText)(guardianPhone, text);
        if (!result.sent && !result.skipped)
            logger_1.logger.warn(`SafeRide360 WhatsApp send failed for ${guardianPhone}: ${result.error}`);
    }
    catch (e) {
        logger_1.logger.warn(`SafeRide360 WhatsApp send threw: ${e.message}`);
    }
}
// ══════════════════════ DRIVER AUTH ══════════════════════════
// Driver registration auto-creates (or reuses) the organization by name —
// matches the spec's "driver just types School Name" simplicity; no
// separate org-admin signup step for MVP.
exports.saferide360Router.post('/auth/driver/register', async (req, res) => {
    try {
        const { name, phone, password, vehicle_number, vehicle_type, organization_name, org_type } = req.body;
        if (!name?.trim() || !phone?.trim() || !password?.trim() || !organization_name?.trim()) {
            fail(res, 'name, phone, password and organization_name are required');
            return;
        }
        const normPhone = (0, whatsapp_1.normalizeWhatsAppPhone)(phone);
        const existing = await (0, db_1.queryOne)('SELECT id FROM saferide360_drivers WHERE phone=$1', [normPhone]);
        if (existing) {
            fail(res, 'Phone already registered');
            return;
        }
        const type = org_type || 'school';
        let org = await (0, db_1.queryOne)('SELECT * FROM saferide360_organizations WHERE name=$1 AND org_type=$2', [organization_name.trim(), type]);
        if (!org) {
            [org] = await (0, db_1.query)(`INSERT INTO saferide360_organizations (name, org_type) VALUES ($1,$2) RETURNING *`, [organization_name.trim(), type]);
        }
        const hash = await bcryptjs_1.default.hash(password, 10);
        const [driver] = await (0, db_1.query)(`INSERT INTO saferide360_drivers (organization_id, name, phone, password_hash, vehicle_number, vehicle_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [org.id, name.trim(), normPhone, hash, vehicle_number || '', vehicle_type || 'van']);
        const token = jsonwebtoken_1.default.sign({ sub: driver.id, role: 'driver', scope: 'saferide360' }, JWT_SECRET, driverSignOptions);
        ok(res, { token, driver: mapDriver(driver), organization: mapOrg(org) }, 201);
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.post('/auth/driver/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        if (!phone?.trim() || !password?.trim()) {
            fail(res, 'phone and password are required');
            return;
        }
        const normPhone = (0, whatsapp_1.normalizeWhatsAppPhone)(phone);
        const driver = await (0, db_1.queryOne)('SELECT * FROM saferide360_drivers WHERE phone=$1', [normPhone]);
        if (!driver) {
            fail(res, 'Invalid phone or password', 401);
            return;
        }
        const valid = await bcryptjs_1.default.compare(password, driver.password_hash);
        if (!valid) {
            fail(res, 'Invalid phone or password', 401);
            return;
        }
        if (driver.is_active === false) {
            fail(res, 'This account has been suspended — contact support.', 403);
            return;
        }
        await (0, db_1.query)('UPDATE saferide360_drivers SET last_login_at=NOW() WHERE id=$1', [driver.id]);
        const token = jsonwebtoken_1.default.sign({ sub: driver.id, role: 'driver', scope: 'saferide360' }, JWT_SECRET, driverSignOptions);
        const org = await (0, db_1.queryOne)('SELECT * FROM saferide360_organizations WHERE id=$1', [driver.organization_id]);
        ok(res, { token, driver: mapDriver(driver), organization: org ? mapOrg(org) : null });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.get('/auth/driver/me', srAuth, requireDriver, async (req, res) => {
    try {
        const driver = await (0, db_1.queryOne)('SELECT * FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        if (!driver) {
            fail(res, 'Driver not found', 404);
            return;
        }
        const org = await (0, db_1.queryOne)('SELECT * FROM saferide360_organizations WHERE id=$1', [driver.organization_id]);
        ok(res, { driver: mapDriver(driver), organization: org ? mapOrg(org) : null });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// Vehicle registration/type were captured at driver registration — this
// lets a driver correct/update them afterward (e.g. a vehicle swap)
// without re-registering.
exports.saferide360Router.patch('/auth/driver/vehicle', srAuth, requireDriver, async (req, res) => {
    try {
        const { vehicle_number, vehicle_type } = req.body;
        if (vehicle_type && !['auto', 'van', 'bus', 'car'].includes(vehicle_type)) {
            fail(res, 'vehicle_type must be one of auto, van, bus, car');
            return;
        }
        const [driver] = await (0, db_1.query)(`UPDATE saferide360_drivers SET vehicle_number=COALESCE($1,vehicle_number), vehicle_type=COALESCE($2,vehicle_type) WHERE id=$3 RETURNING *`, [vehicle_number, vehicle_type, req.srUser.sub]);
        if (!driver) {
            fail(res, 'Driver not found', 404);
            return;
        }
        ok(res, mapDriver(driver));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// Package plan: INR 100/passenger/month (org-configurable rate). Shows the
// driver dashboard exactly what they're paying for and when the free trial
// ends — no surprise paywall at Start Trip.
exports.saferide360Router.get('/organization/billing', srAuth, requireDriver, async (req, res) => {
    try {
        const driver = await (0, db_1.queryOne)('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        const org = await (0, db_1.queryOne)('SELECT * FROM saferide360_organizations WHERE id=$1', [driver.organization_id]);
        if (!org) {
            fail(res, 'Organization not found', 404);
            return;
        }
        const passengerCount = await (0, db_1.queryOne)('SELECT COUNT(*)::int AS n FROM saferide360_passengers WHERE organization_id=$1', [driver.organization_id]);
        ok(res, {
            organization: mapOrg(org),
            passengerCount: passengerCount.n,
            monthlyCost: passengerCount.n * org.plan_rate_inr_per_passenger,
            isActive: isSubscriptionActive(org),
            inTrial: new Date(org.trial_ends_at).getTime() > Date.now(),
        });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ══════════════════════ GUARDIAN AUTH (WhatsApp OTP) ═════════════════════
// "Parent does not create an account" — a guardian's identity is just the
// set of passengers whose guardian_phone matches their OTP-verified
// number, looked up fresh on every request. Isolated OTP table (see
// migration 077) — dedicated rate-limit/expiry, not the generic
// otp_verifications table used elsewhere for a different purpose.
function genOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
}
exports.saferide360Router.post('/auth/guardian/send-otp', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone?.trim()) {
            fail(res, 'phone is required');
            return;
        }
        const normPhone = (0, whatsapp_1.normalizeWhatsAppPhone)(phone);
        const linked = await (0, db_1.queryOne)('SELECT 1 FROM saferide360_passengers WHERE guardian_phone=$1 LIMIT 1', [normPhone]);
        if (!linked) {
            fail(res, 'This number is not linked to any child on SafeRide360 — ask your driver to add it.', 404);
            return;
        }
        const existing = await (0, db_1.queryOne)('SELECT created_at FROM saferide360_otp WHERE phone=$1', [normPhone]);
        if (existing && Date.now() - new Date(existing.created_at).getTime() < 60000) {
            fail(res, 'Please wait before requesting another code');
            return;
        }
        const otp = genOtp();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
        await (0, db_1.query)(`INSERT INTO saferide360_otp (phone, otp_code, expires_at) VALUES ($1,$2,$3)
       ON CONFLICT (phone) DO UPDATE SET otp_code=$2, expires_at=$3, verified_at=NULL, created_at=NOW()`, [normPhone, otp, expiresAt]);
        const result = await (0, whatsapp_1.sendWhatsAppText)(normPhone, `🔐 *SafeRide360 Verification*\n\nYour code is: *${otp}*\n\n_Expires in 10 minutes. Do not share this with anyone._`);
        if (!result.sent && !result.skipped) {
            fail(res, result.error || 'Failed to send the verification code');
            return;
        }
        ok(res, { sent: true, skipped: result.skipped || false, hint: result.skipped ? 'WhatsApp not configured on this server — code logged server-side for dev testing' : undefined });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.post('/auth/guardian/verify-otp', async (req, res) => {
    try {
        const { phone, otp } = req.body;
        if (!phone?.trim() || !otp?.trim()) {
            fail(res, 'phone and otp are required');
            return;
        }
        const normPhone = (0, whatsapp_1.normalizeWhatsAppPhone)(phone);
        const row = await (0, db_1.queryOne)('SELECT * FROM saferide360_otp WHERE phone=$1', [normPhone]);
        if (!row) {
            fail(res, 'Code not found — request a new one', 404);
            return;
        }
        if (row.verified_at) {
            fail(res, 'Code already used — request a new one');
            return;
        }
        if (new Date(row.expires_at) < new Date()) {
            fail(res, 'Code expired — request a new one');
            return;
        }
        if (row.otp_code !== otp.trim()) {
            fail(res, 'Incorrect code');
            return;
        }
        await (0, db_1.query)('UPDATE saferide360_otp SET verified_at=NOW() WHERE phone=$1', [normPhone]);
        const token = jsonwebtoken_1.default.sign({ sub: normPhone, role: 'guardian', scope: 'saferide360' }, JWT_SECRET, guardianSignOptions);
        ok(res, { token, phone: normPhone });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// Phone-only guardian login — no OTP verification. Chosen deliberately: the
// WhatsApp Cloud API sandbox restricts OTP delivery to pre-approved test
// numbers (#131030 "Recipient phone number not in allowed list"), which
// blocked real parents from ever getting a code. A guardian's "identity" on
// this product is already just "the phone number on a passenger record" —
// this trades phone-ownership verification for reliability, matching what
// was explicitly requested.
exports.saferide360Router.post('/auth/guardian/login', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone?.trim()) {
            fail(res, 'phone is required');
            return;
        }
        const normPhone = (0, whatsapp_1.normalizeWhatsAppPhone)(phone);
        const linked = await (0, db_1.queryOne)('SELECT 1 FROM saferide360_passengers WHERE guardian_phone=$1 LIMIT 1', [normPhone]);
        if (!linked) {
            fail(res, 'This number is not linked to any child on SafeRide360 — ask your driver to add it.', 404);
            return;
        }
        const token = jsonwebtoken_1.default.sign({ sub: normPhone, role: 'guardian', scope: 'saferide360' }, JWT_SECRET, guardianSignOptions);
        ok(res, { token, phone: normPhone });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ══════════════════════ STOPS ═══════════════════════════════════════════
exports.saferide360Router.get('/stops', srAuth, requireDriver, async (req, res) => {
    try {
        const driver = await (0, db_1.queryOne)('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        const rows = await (0, db_1.query)('SELECT * FROM saferide360_stops WHERE organization_id=$1 ORDER BY sequence ASC', [driver.organization_id]);
        ok(res, rows.map(mapStop));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.post('/stops', srAuth, requireDriver, async (req, res) => {
    try {
        const { name, lat, lng, sequence } = req.body;
        if (!name?.trim() || lat == null || lng == null) {
            fail(res, 'name, lat and lng are required');
            return;
        }
        const driver = await (0, db_1.queryOne)('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        const [row] = await (0, db_1.query)(`INSERT INTO saferide360_stops (organization_id, name, lat, lng, sequence) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [driver.organization_id, name.trim(), lat, lng, sequence ?? 0]);
        ok(res, mapStop(row), 201);
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.patch('/stops/:id', srAuth, requireDriver, async (req, res) => {
    try {
        const { name, lat, lng, sequence } = req.body;
        const driver = await (0, db_1.queryOne)('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        const [row] = await (0, db_1.query)(`UPDATE saferide360_stops SET name=COALESCE($1,name), lat=COALESCE($2,lat), lng=COALESCE($3,lng), sequence=COALESCE($4,sequence)
       WHERE id=$5 AND organization_id=$6 RETURNING *`, [name, lat, lng, sequence, req.params.id, driver.organization_id]);
        if (!row) {
            fail(res, 'Stop not found', 404);
            return;
        }
        ok(res, mapStop(row));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.delete('/stops/:id', srAuth, requireDriver, async (req, res) => {
    try {
        const driver = await (0, db_1.queryOne)('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        await (0, db_1.query)('DELETE FROM saferide360_stops WHERE id=$1 AND organization_id=$2', [req.params.id, driver.organization_id]);
        ok(res, { deleted: true });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ══════════════════════ GEOCODE (location search) ════════════════════════
// Free, no-API-key location-suggestion search for the stop-name field, so a
// driver doesn't have to type/know raw lat/lng. Proxied server-side (rather
// than called directly from the browser) because Nominatim's usage policy
// requires a real, identifying User-Agent and rate-limits per source.
exports.saferide360Router.get('/geocode/search', srAuth, requireDriver, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 3) {
            ok(res, []);
            return;
        }
        const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=6&q=${encodeURIComponent(q)}`;
        const r = await fetch(url, { headers: { 'User-Agent': 'SafeRide360/1.0 (safety-transport-tracking)' } });
        if (!r.ok) {
            fail(res, 'Location search is temporarily unavailable', 502);
            return;
        }
        const results = await r.json();
        ok(res, results.map(x => ({ label: x.display_name, lat: parseFloat(x.lat), lng: parseFloat(x.lon) })));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ══════════════════════ PASSENGERS ═══════════════════════════════════════
exports.saferide360Router.get('/passengers', srAuth, requireDriver, async (req, res) => {
    try {
        const driver = await (0, db_1.queryOne)('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        const rows = await (0, db_1.query)('SELECT * FROM saferide360_passengers WHERE organization_id=$1 ORDER BY created_at ASC', [driver.organization_id]);
        ok(res, rows.map(mapPassenger));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.post('/passengers', srAuth, requireDriver, async (req, res) => {
    try {
        const { name, guardian_name, guardian_phone, pickup_stop_id, drop_stop_id, school_name } = req.body;
        if (!name?.trim() || !guardian_name?.trim() || !guardian_phone?.trim()) {
            fail(res, 'name, guardian_name and guardian_phone are required');
            return;
        }
        const driver = await (0, db_1.queryOne)('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        // Defaults to the org's own name when not overridden — supports a
        // shared van serving kids from more than one school.
        let schoolName = school_name?.trim();
        if (!schoolName) {
            const org = await (0, db_1.queryOne)('SELECT name FROM saferide360_organizations WHERE id=$1', [driver.organization_id]);
            schoolName = org?.name;
        }
        const [row] = await (0, db_1.query)(`INSERT INTO saferide360_passengers (organization_id, name, guardian_name, guardian_phone, pickup_stop_id, drop_stop_id, school_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [driver.organization_id, name.trim(), guardian_name.trim(), (0, whatsapp_1.normalizeWhatsAppPhone)(guardian_phone), pickup_stop_id || null, drop_stop_id || null, schoolName || null]);
        ok(res, mapPassenger(row), 201);
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.patch('/passengers/:id', srAuth, requireDriver, async (req, res) => {
    try {
        const { name, guardian_name, guardian_phone, pickup_stop_id, drop_stop_id, school_name } = req.body;
        const driver = await (0, db_1.queryOne)('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        const [row] = await (0, db_1.query)(`UPDATE saferide360_passengers SET
         name=COALESCE($1,name), guardian_name=COALESCE($2,guardian_name),
         guardian_phone=COALESCE($3,guardian_phone), pickup_stop_id=COALESCE($4,pickup_stop_id), drop_stop_id=COALESCE($5,drop_stop_id),
         school_name=COALESCE($6,school_name)
       WHERE id=$7 AND organization_id=$8 RETURNING *`, [name, guardian_name, guardian_phone ? (0, whatsapp_1.normalizeWhatsAppPhone)(guardian_phone) : null, pickup_stop_id, drop_stop_id, school_name, req.params.id, driver.organization_id]);
        if (!row) {
            fail(res, 'Passenger not found', 404);
            return;
        }
        ok(res, mapPassenger(row));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.delete('/passengers/:id', srAuth, requireDriver, async (req, res) => {
    try {
        const driver = await (0, db_1.queryOne)('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        await (0, db_1.query)('DELETE FROM saferide360_passengers WHERE id=$1 AND organization_id=$2', [req.params.id, driver.organization_id]);
        ok(res, { deleted: true });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ══════════════════════ TRIP TEMPLATES ════════════════════════════════════
// "Configure trip by selecting students and save as a template" — a named,
// reusable student roster a driver picks when creating a trip instead of
// re-selecting the same students every day. Editable in place (PATCH
// replaces the passenger list), not just create/delete.
exports.saferide360Router.get('/trip-templates', srAuth, requireDriver, async (req, res) => {
    try {
        const driver = await (0, db_1.queryOne)('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        const rows = await (0, db_1.query)('SELECT * FROM saferide360_trip_templates WHERE organization_id=$1 ORDER BY created_at DESC', [driver.organization_id]);
        ok(res, rows.map(mapTripTemplate));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.post('/trip-templates', srAuth, requireDriver, async (req, res) => {
    try {
        const { name, passenger_ids } = req.body;
        if (!name?.trim() || !Array.isArray(passenger_ids) || passenger_ids.length === 0) {
            fail(res, 'name and at least one passenger are required');
            return;
        }
        const driver = await (0, db_1.queryOne)('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        const [row] = await (0, db_1.query)(`INSERT INTO saferide360_trip_templates (organization_id, name, passenger_ids) VALUES ($1,$2,$3) RETURNING *`, [driver.organization_id, name.trim(), JSON.stringify(passenger_ids)]);
        ok(res, mapTripTemplate(row), 201);
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.patch('/trip-templates/:id', srAuth, requireDriver, async (req, res) => {
    try {
        const { name, passenger_ids } = req.body;
        const driver = await (0, db_1.queryOne)('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        const [row] = await (0, db_1.query)(`UPDATE saferide360_trip_templates SET name=COALESCE($1,name), passenger_ids=COALESCE($2,passenger_ids)
       WHERE id=$3 AND organization_id=$4 RETURNING *`, [name, passenger_ids ? JSON.stringify(passenger_ids) : null, req.params.id, driver.organization_id]);
        if (!row) {
            fail(res, 'Template not found', 404);
            return;
        }
        ok(res, mapTripTemplate(row));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.delete('/trip-templates/:id', srAuth, requireDriver, async (req, res) => {
    try {
        const driver = await (0, db_1.queryOne)('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        await (0, db_1.query)('DELETE FROM saferide360_trip_templates WHERE id=$1 AND organization_id=$2', [req.params.id, driver.organization_id]);
        ok(res, { deleted: true });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ══════════════════════ TRIPS ═════════════════════════════════════════════
exports.saferide360Router.get('/trips', srAuth, requireDriver, async (req, res) => {
    try {
        const rows = await (0, db_1.query)('SELECT * FROM saferide360_trips WHERE driver_id=$1 ORDER BY created_at DESC', [req.srUser.sub]);
        ok(res, rows.map(mapTrip));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.post('/trips', srAuth, requireDriver, async (req, res) => {
    try {
        const { name, direction, scheduled_start_time, scheduled_end_time, template_id } = req.body;
        if (!name?.trim() || !scheduled_start_time || !scheduled_end_time) {
            fail(res, 'name, scheduled_start_time and scheduled_end_time are required');
            return;
        }
        const driver = await (0, db_1.queryOne)('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        const [row] = await (0, db_1.query)(`INSERT INTO saferide360_trips (organization_id, driver_id, name, direction, scheduled_start_time, scheduled_end_time, template_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [driver.organization_id, req.srUser.sub, name.trim(), direction || 'pickup', scheduled_start_time, scheduled_end_time, template_id || null]);
        ok(res, mapTrip(row), 201);
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.patch('/trips/:id', srAuth, requireDriver, async (req, res) => {
    try {
        const { name, scheduled_start_time, scheduled_end_time } = req.body;
        const [row] = await (0, db_1.query)(`UPDATE saferide360_trips SET name=COALESCE($1,name), scheduled_start_time=COALESCE($2,scheduled_start_time), scheduled_end_time=COALESCE($3,scheduled_end_time)
       WHERE id=$4 AND driver_id=$5 RETURNING *`, [name, scheduled_start_time, scheduled_end_time, req.params.id, req.srUser.sub]);
        if (!row) {
            fail(res, 'Trip not found', 404);
            return;
        }
        ok(res, mapTrip(row));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// Seeds today's trip_passengers from every passenger whose relevant stop
// (pickup for a 'pickup' trip, drop for a 'drop' trip) belongs to this
// organization — one row per passenger, fresh each time a trip starts
// (matches the 2-day-retention design: this is ephemeral daily state, not
// master data).
exports.saferide360Router.post('/trips/:id/start', srAuth, requireDriver, async (req, res) => {
    try {
        const trip = await (0, db_1.queryOne)('SELECT * FROM saferide360_trips WHERE id=$1 AND driver_id=$2', [req.params.id, req.srUser.sub]);
        if (!trip) {
            fail(res, 'Trip not found', 404);
            return;
        }
        if (trip.status === 'active') {
            fail(res, 'Trip is already active');
            return;
        }
        const org = await (0, db_1.queryOne)('SELECT * FROM saferide360_organizations WHERE id=$1', [trip.organization_id]);
        if (!isSubscriptionActive(org)) {
            const passengerCount = await (0, db_1.queryOne)('SELECT COUNT(*)::int AS n FROM saferide360_passengers WHERE organization_id=$1', [trip.organization_id]);
            const monthlyCost = passengerCount.n * org.plan_rate_inr_per_passenger;
            res.status(402).json({
                success: false,
                error: `Your free trial has ended. ${org.name} has ${passengerCount.n} passenger(s) — ₹${org.plan_rate_inr_per_passenger}/passenger/month = ₹${monthlyCost}/month to continue.`,
                code: 'SUBSCRIPTION_REQUIRED',
                passengerCount: passengerCount.n, ratePerPassenger: org.plan_rate_inr_per_passenger, monthlyCost,
                timestamp: new Date().toISOString(),
            });
            return;
        }
        const stopCol = trip.direction === 'drop' ? 'drop_stop_id' : 'pickup_stop_id';
        // A template scopes the roster to a saved student selection (e.g. "Van A
        // route"); without one, every org passenger with this direction's stop
        // set rides — the original, still-supported default behavior.
        let passengers;
        if (trip.template_id) {
            const template = await (0, db_1.queryOne)('SELECT * FROM saferide360_trip_templates WHERE id=$1', [trip.template_id]);
            const ids = template?.passenger_ids || [];
            passengers = ids.length === 0 ? [] : await (0, db_1.query)(`SELECT p.* FROM saferide360_passengers p WHERE p.organization_id=$1 AND p.${stopCol} IS NOT NULL AND p.id = ANY($2::uuid[])`, [trip.organization_id, ids]);
        }
        else {
            passengers = await (0, db_1.query)(`SELECT p.* FROM saferide360_passengers p WHERE p.organization_id=$1 AND p.${stopCol} IS NOT NULL`, [trip.organization_id]);
        }
        if (passengers.length === 0) {
            fail(res, `No students are assigned a ${trip.direction} stop yet — add students under Passengers before starting this trip.`);
            return;
        }
        for (const p of passengers) {
            await (0, db_1.query)(`INSERT INTO saferide360_trip_passengers (trip_id, passenger_id) VALUES ($1,$2)`, [trip.id, p.id]);
        }
        const [updated] = await (0, db_1.query)(`UPDATE saferide360_trips SET status='active', actual_start_at=NOW() WHERE id=$1 RETURNING *`, [trip.id]);
        const driver = await (0, db_1.queryOne)('SELECT * FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        for (const p of passengers) {
            await pushGuardianNotif(p.guardian_phone, 'trip_started', `🚐 *${trip.name}* has started.\n\nDriver: ${driver.name}\nVehicle: ${driver.vehicle_number}\n\nTrack live in SafeRide360.`, trip.id, p.id);
        }
        ok(res, mapTrip(updated));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// Driver's device calls this every ~5-10s while a trip is active — matches
// the exact polling pattern the existing Ride360 module already uses
// (PATCH .../live), rather than introducing WebSockets/pub-sub for a
// slow-moving vehicle.
exports.saferide360Router.patch('/trips/:id/live', srAuth, requireDriver, async (req, res) => {
    try {
        const { lat, lng } = req.body;
        if (lat == null || lng == null) {
            fail(res, 'lat and lng are required');
            return;
        }
        const [row] = await (0, db_1.query)(`UPDATE saferide360_trips SET live_lat=$1, live_lng=$2, live_updated_at=NOW() WHERE id=$3 AND driver_id=$4 AND status='active' RETURNING *`, [lat, lng, req.params.id, req.srUser.sub]);
        if (!row) {
            fail(res, 'Active trip not found', 404);
            return;
        }
        await (0, db_1.query)(`INSERT INTO saferide360_gps_pings (trip_id, lat, lng) VALUES ($1,$2,$3)`, [row.id, lat, lng]);
        ok(res, mapTrip(row));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// Ordered by the trip's relevant stop sequence (pickup order for a
// 'pickup' trip, drop order for a 'drop' trip) so the driver sees students
// in the order they'll actually be encountered along the route, not
// alphabetically.
exports.saferide360Router.get('/trips/:id/passengers', srAuth, requireDriver, async (req, res) => {
    try {
        const trip = await (0, db_1.queryOne)('SELECT direction FROM saferide360_trips WHERE id=$1', [req.params.id]);
        if (!trip) {
            fail(res, 'Trip not found', 404);
            return;
        }
        const stopCol = trip.direction === 'drop' ? 'drop_stop_id' : 'pickup_stop_id';
        const rows = await (0, db_1.query)(`SELECT tp.*, p.name AS passenger_name, p.guardian_phone, s.sequence AS stop_sequence
       FROM saferide360_trip_passengers tp
       JOIN saferide360_passengers p ON p.id = tp.passenger_id
       LEFT JOIN saferide360_stops s ON s.id = p.${stopCol}
       WHERE tp.trip_id=$1 ORDER BY s.sequence ASC NULLS LAST, p.name ASC`, [req.params.id]);
        ok(res, rows.map((r) => ({ ...mapTripPassenger(r), passengerName: r.passenger_name })));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// status: 'picked' | 'absent' — a third state beyond picked/pending so an
// absent child doesn't sit as "pending" forever and read as a stuck trip
// to an anxious parent.
exports.saferide360Router.patch('/trip-passengers/:id', srAuth, requireDriver, async (req, res) => {
    try {
        const { status } = req.body;
        if (!status || !['picked', 'absent'].includes(status)) {
            fail(res, "status must be 'picked' or 'absent'");
            return;
        }
        const [row] = await (0, db_1.query)(`UPDATE saferide360_trip_passengers SET status=$1, picked_at=CASE WHEN $1::VARCHAR='picked' THEN NOW() ELSE picked_at END WHERE id=$2 RETURNING *`, [status, req.params.id]);
        if (!row) {
            fail(res, 'Trip passenger not found', 404);
            return;
        }
        const p = await (0, db_1.queryOne)('SELECT * FROM saferide360_passengers WHERE id=$1', [row.passenger_id]);
        if (p) {
            const text = status === 'picked'
                ? `✅ *${p.name}* has boarded the vehicle.\n\nTime: ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
                : `ℹ️ *${p.name}* marked absent for today's trip.`;
            await pushGuardianNotif(p.guardian_phone, status === 'picked' ? 'student_picked' : 'student_absent', text, row.trip_id, p.id);
        }
        ok(res, mapTripPassenger(row));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// Safety gate: any student never explicitly confirmed defaults to absent
// (rather than staying ambiguously "pending"), then the driver must confirm
// a headcount of students physically in the vehicle that matches the
// confirmed/picked count before the trip can complete — catches a driver
// who tapped "picked" for a student who then didn't actually board.
exports.saferide360Router.post('/trips/:id/complete', srAuth, requireDriver, async (req, res) => {
    try {
        const { confirmed_in_vehicle } = req.body;
        const trip = await (0, db_1.queryOne)('SELECT * FROM saferide360_trips WHERE id=$1 AND driver_id=$2', [req.params.id, req.srUser.sub]);
        if (!trip) {
            fail(res, 'Trip not found', 404);
            return;
        }
        await (0, db_1.query)(`UPDATE saferide360_trip_passengers SET status='absent' WHERE trip_id=$1 AND status='pending'`, [trip.id]);
        const pickedCount = await (0, db_1.queryOne)(`SELECT COUNT(*)::int AS n FROM saferide360_trip_passengers WHERE trip_id=$1 AND status='picked'`, [trip.id]);
        if (confirmed_in_vehicle == null) {
            fail(res, `Confirm the number of students physically in the vehicle before completing this trip. ${pickedCount.n} student(s) are marked picked up.`, 400);
            return;
        }
        if (confirmed_in_vehicle !== pickedCount.n) {
            res.status(409).json({
                success: false,
                error: `Headcount mismatch — ${pickedCount.n} student(s) marked picked up in the app, but you confirmed ${confirmed_in_vehicle} in the vehicle. Recheck and update each student's status before completing.`,
                code: 'HEADCOUNT_MISMATCH',
                confirmedPicked: pickedCount.n, confirmedInVehicle: confirmed_in_vehicle,
                timestamp: new Date().toISOString(),
            });
            return;
        }
        const [updated] = await (0, db_1.query)(`UPDATE saferide360_trips SET status='completed', actual_end_at=NOW() WHERE id=$1 RETURNING *`, [trip.id]);
        const passengers = await (0, db_1.query)(`SELECT tp.*, p.name AS passenger_name, p.guardian_phone
       FROM saferide360_trip_passengers tp JOIN saferide360_passengers p ON p.id = tp.passenger_id
       WHERE tp.trip_id=$1 AND tp.status='picked'`, [trip.id]);
        const arrivalText = trip.direction === 'drop' ? 'reached home safely' : 'reached school safely';
        for (const p of passengers) {
            await pushGuardianNotif(p.guardian_phone, 'trip_completed', `🏁 *${p.passenger_name}* has ${arrivalText}.`, trip.id, p.passenger_id);
        }
        ok(res, mapTrip(updated));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// Driver-facing SOS — cheap to have in MVP (just another WhatsApp broadcast
// + notification rows), matching the product's own "are they safe?"
// guiding principle rather than deferring it to "future."
// Shared by SOS and the general trip-alert broadcast below — both are the
// exact same delivery mechanism (every guardian with a passenger on this
// specific trip, and only this trip), just different urgency/type tagging.
async function broadcastToTripGuardians(tripId, type, text) {
    const passengers = await (0, db_1.query)(`SELECT p.* FROM saferide360_trip_passengers tp JOIN saferide360_passengers p ON p.id = tp.passenger_id WHERE tp.trip_id=$1`, [tripId]);
    for (const p of passengers) {
        await pushGuardianNotif(p.guardian_phone, type, text, tripId, p.id);
    }
    return passengers.length;
}
exports.saferide360Router.post('/trips/:id/sos', srAuth, requireDriver, async (req, res) => {
    try {
        const trip = await (0, db_1.queryOne)('SELECT * FROM saferide360_trips WHERE id=$1 AND driver_id=$2', [req.params.id, req.srUser.sub]);
        if (!trip) {
            fail(res, 'Trip not found', 404);
            return;
        }
        const driver = await (0, db_1.queryOne)('SELECT * FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        const alerted = await broadcastToTripGuardians(trip.id, 'sos', `🚨 *Emergency alert* on ${trip.name} — driver ${driver.name} (${driver.vehicle_number}) has raised an SOS. Please contact the school immediately.`);
        ok(res, { alerted });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// Driver-authored update — vehicle issue / traffic / delay / anything else
// worth telling every parent on this specific trip, typed or (client-side)
// transcribed from a voice recording. Not an emergency — same delivery
// mechanism as SOS, lower urgency framing.
const ALERT_TYPE_LABELS = {
    delay: '⏰ Delay',
    traffic: '🚦 Traffic',
    vehicle_issue: '🔧 Vehicle Issue',
    custom: '📢 Update',
};
exports.saferide360Router.post('/trips/:id/alert', srAuth, requireDriver, async (req, res) => {
    try {
        const { message, alert_type } = req.body;
        if (!message?.trim()) {
            fail(res, 'message is required');
            return;
        }
        const trip = await (0, db_1.queryOne)('SELECT * FROM saferide360_trips WHERE id=$1 AND driver_id=$2', [req.params.id, req.srUser.sub]);
        if (!trip) {
            fail(res, 'Trip not found', 404);
            return;
        }
        const driver = await (0, db_1.queryOne)('SELECT * FROM saferide360_drivers WHERE id=$1', [req.srUser.sub]);
        const type = alert_type && ALERT_TYPE_LABELS[alert_type] ? alert_type : 'custom';
        const label = ALERT_TYPE_LABELS[type];
        const text = `${label} — *${trip.name}*\n\n${message.trim()}\n\n— ${driver.name}, ${driver.vehicle_number}`;
        const alerted = await broadcastToTripGuardians(trip.id, 'trip_alert', text);
        ok(res, { alerted });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ══════════════════════ GUARDIAN VIEWS ═══════════════════════════════════
exports.saferide360Router.get('/guardian/children', srAuth, requireGuardian, async (req, res) => {
    try {
        const rows = await (0, db_1.query)('SELECT * FROM saferide360_passengers WHERE guardian_phone=$1', [req.srUser.sub]);
        ok(res, rows.map(mapPassenger));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// Today's trip status for every one of this guardian's children — may span
// multiple trips/drivers/organizations if they have kids at different
// stops or schools.
exports.saferide360Router.get('/guardian/today', srAuth, requireGuardian, async (req, res) => {
    try {
        const rows = await (0, db_1.query)(`SELECT tp.*, p.name AS passenger_name, p.pickup_stop_id, p.drop_stop_id,
              t.id AS trip_id_full, t.name AS trip_name, t.status AS trip_status, t.direction,
              t.live_lat, t.live_lng, t.live_updated_at, t.actual_start_at,
              d.name AS driver_name, d.phone AS driver_phone, d.vehicle_number, d.vehicle_type
       FROM saferide360_trip_passengers tp
       JOIN saferide360_passengers p ON p.id = tp.passenger_id
       JOIN saferide360_trips t ON t.id = tp.trip_id
       JOIN saferide360_drivers d ON d.id = t.driver_id
       WHERE p.guardian_phone=$1 AND t.created_at >= NOW() - INTERVAL '2 days'
       ORDER BY t.created_at DESC`, [req.srUser.sub]);
        ok(res, rows.map((r) => ({
            tripPassengerId: r.id, passengerId: r.passenger_id, passengerName: r.passenger_name, status: r.status, pickedAt: r.picked_at || undefined,
            tripId: r.trip_id_full, tripName: r.trip_name, tripStatus: r.trip_status, direction: r.direction,
            liveLat: r.live_lat != null ? Number(r.live_lat) : undefined, liveLng: r.live_lng != null ? Number(r.live_lng) : undefined, liveUpdatedAt: r.live_updated_at || undefined,
            driverName: r.driver_name, driverPhone: r.driver_phone, vehicleNumber: r.vehicle_number, vehicleType: r.vehicle_type,
        })));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.get('/guardian/trips/:id/stops', srAuth, requireGuardian, async (req, res) => {
    try {
        const trip = await (0, db_1.queryOne)('SELECT * FROM saferide360_trips WHERE id=$1', [req.params.id]);
        if (!trip) {
            fail(res, 'Trip not found', 404);
            return;
        }
        const stops = await (0, db_1.query)('SELECT * FROM saferide360_stops WHERE organization_id=$1 ORDER BY sequence ASC', [trip.organization_id]);
        ok(res, stops.map(mapStop));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.get('/guardian/notifications', srAuth, requireGuardian, async (req, res) => {
    try {
        const rows = await (0, db_1.query)('SELECT * FROM saferide360_notifications WHERE guardian_phone=$1 ORDER BY created_at DESC LIMIT 100', [req.srUser.sub]);
        ok(res, rows.map(mapNotification));
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.saferide360Router.patch('/guardian/notifications/read-all', srAuth, requireGuardian, async (req, res) => {
    try {
        await (0, db_1.query)('UPDATE saferide360_notifications SET read=TRUE WHERE guardian_phone=$1 AND read=FALSE', [req.srUser.sub]);
        ok(res, { updated: true });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ── LIVE LOCATION UPDATES (every 10 min, while a trip is active) ─────────
// Separate from the ~7s live_lat/live_lng polling that drives the map —
// this is an explicit push notification so a parent who isn't looking at
// the app still hears "here's where the vehicle is" periodically. The
// interval and the type-specific retention below are both named constants
// ("do the setting for sending and cleaning"), not magic numbers.
const LOCATION_UPDATE_INTERVAL_MS = 10 * 60000;
const LOCATION_UPDATE_RETENTION_DAYS = 1; // shorter than the guardian-notification default — these are high-frequency and low-value after the fact
const TRIP_DATA_RETENTION_DAYS = 2; // ephemeral GPS pings / trip_passengers / completed trips — distinct from the guardian-facing notification list below
const DEFAULT_GUARDIAN_NOTIFICATION_RETENTION_DAYS = 5;
// Superadmin-configurable via PUT /v1/superadmin/platform-config with
// { key: "saferide360", value: { notificationRetentionDays } } — same
// generic platform_config table/pattern already used by College360's
// config tab, so "keep last 5 days" is a setting, not a hardcoded number.
async function getGuardianNotificationRetentionDays() {
    try {
        const row = await (0, db_1.queryOne)(`SELECT value FROM platform_config WHERE key='saferide360'`);
        const days = row?.value?.notificationRetentionDays;
        return typeof days === 'number' && days > 0 ? days : DEFAULT_GUARDIAN_NOTIFICATION_RETENTION_DAYS;
    }
    catch {
        return DEFAULT_GUARDIAN_NOTIFICATION_RETENTION_DAYS;
    }
}
async function runSafeRide360LocationUpdateJob() {
    try {
        const activeTrips = await (0, db_1.query)(`SELECT t.*, d.name AS driver_name, d.vehicle_number
       FROM saferide360_trips t JOIN saferide360_drivers d ON d.id = t.driver_id
       WHERE t.status='active' AND t.live_lat IS NOT NULL AND t.live_lng IS NOT NULL`);
        let sent = 0;
        for (const trip of activeTrips) {
            const mapsLink = `https://www.google.com/maps?q=${trip.live_lat},${trip.live_lng}`;
            const text = `📍 *${trip.name}* location update\n\n${driverLabelFor(trip)}\nCurrent location: ${mapsLink}\nLast updated: ${new Date(trip.live_updated_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
            sent += await broadcastToTripGuardians(trip.id, 'location_update', text);
        }
        if (activeTrips.length)
            logger_1.logger.info(`[SafeRide360:location] Sent location updates for ${activeTrips.length} active trip(s), ${sent} notification(s)`);
    }
    catch (e) {
        logger_1.logger.error(`[SafeRide360:location] Job failed: ${e.message}`);
    }
}
function driverLabelFor(trip) {
    return `Driver: ${trip.driver_name} · Vehicle: ${trip.vehicle_number}`;
}
// ── RETENTION ──────────────────────────────────────────────────────────────
// Ephemeral daily/trip data only — passenger/stop/organization/driver
// master data is never touched. Wired into the existing background-service
// setInterval pattern (backend/src/modules/public/background.service.ts),
// not a new cron dependency.
async function runSafeRide360RetentionJob() {
    try {
        const notifRetentionDays = await getGuardianNotificationRetentionDays();
        const gps = await (0, db_1.query)(`DELETE FROM saferide360_gps_pings WHERE recorded_at < NOW() - INTERVAL '${TRIP_DATA_RETENTION_DAYS} days' RETURNING id`);
        const locNotif = await (0, db_1.query)(`DELETE FROM saferide360_notifications WHERE type='location_update' AND created_at < NOW() - INTERVAL '${LOCATION_UPDATE_RETENTION_DAYS} days' RETURNING id`);
        const notif = await (0, db_1.query)(`DELETE FROM saferide360_notifications WHERE type != 'location_update' AND created_at < NOW() - INTERVAL '${notifRetentionDays} days' RETURNING id`);
        const tp = await (0, db_1.query)(`DELETE FROM saferide360_trip_passengers WHERE created_at < NOW() - INTERVAL '${TRIP_DATA_RETENTION_DAYS} days' RETURNING id`);
        const trips = await (0, db_1.query)(`DELETE FROM saferide360_trips WHERE status='completed' AND actual_end_at < NOW() - INTERVAL '${TRIP_DATA_RETENTION_DAYS} days' RETURNING id`);
        if (gps.length || locNotif.length || notif.length || tp.length || trips.length) {
            logger_1.logger.info(`[SafeRide360:retention] purged gps=${gps.length} location_notifications=${locNotif.length} other_notifications=${notif.length} (retention=${notifRetentionDays}d) trip_passengers=${tp.length} trips=${trips.length}`);
        }
    }
    catch (e) {
        logger_1.logger.error(`[SafeRide360:retention] Job failed: ${e.message}`);
    }
}
