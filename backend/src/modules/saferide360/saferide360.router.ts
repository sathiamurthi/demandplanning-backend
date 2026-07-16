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
import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import { query, queryOne } from '../../config/db';
import { sendWhatsAppText, normalizeWhatsAppPhone } from '../../utils/whatsapp';
import { logger } from '../../config/logger';

export const saferide360Router = Router();

// ── Config ───────────────────────────────────────────────────
const JWT_SECRET: Secret = (process.env.JWT_SECRET || 'dev-secret-change-this') as Secret;
const driverSignOptions: SignOptions = { expiresIn: 30 * 24 * 3600 }; // 30 days, matches Ride360's driver session length
const guardianSignOptions: SignOptions = { expiresIn: 24 * 3600 }; // 1 day — re-verify via OTP daily, lower-stakes to re-auth

// ── Helpers ──────────────────────────────────────────────────
function ok(res: Response, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: Response, message: string, status = 400) {
  res.status(status).json({ success: false, error: message, timestamp: new Date().toISOString() });
}

interface SRReq extends Request { srUser?: { sub: string; role: 'driver' | 'guardian' } }

function srAuth(req: SRReq, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
  try {
    const decoded: any = jwt.verify(header.slice(7), JWT_SECRET);
    if (decoded.scope !== 'saferide360') { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
    req.srUser = { sub: decoded.sub, role: decoded.role };
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Token expired or invalid' });
  }
}
function requireDriver(req: SRReq, res: Response, next: NextFunction) {
  if (req.srUser?.role !== 'driver') { res.status(403).json({ success: false, error: 'Driver account required' }); return; }
  next();
}
function requireGuardian(req: SRReq, res: Response, next: NextFunction) {
  if (req.srUser?.role !== 'guardian') { res.status(403).json({ success: false, error: 'Guardian account required' }); return; }
  next();
}

// ── Row -> frontend-shape mappers ─────────────────────────────
function mapOrg(row: any) {
  return {
    id: row.id, name: row.name, orgType: row.org_type, createdAt: row.created_at,
    trialEndsAt: row.trial_ends_at, subscriptionActiveUntil: row.subscription_active_until || undefined,
    planRateInrPerPassenger: row.plan_rate_inr_per_passenger,
  };
}
// Package plan: INR 100/passenger/month by default (per-org, in case a
// future negotiated rate differs). Active if still inside the trial
// window OR paid up (subscription_active_until in the future).
function isSubscriptionActive(org: any): boolean {
  const now = Date.now();
  if (org.trial_ends_at && new Date(org.trial_ends_at).getTime() > now) return true;
  if (org.subscription_active_until && new Date(org.subscription_active_until).getTime() > now) return true;
  return false;
}
function mapDriver(row: any) {
  return { id: row.id, organizationId: row.organization_id, name: row.name, phone: row.phone, vehicleNumber: row.vehicle_number, vehicleType: row.vehicle_type, createdAt: row.created_at };
}
function mapStop(row: any) {
  return { id: row.id, organizationId: row.organization_id, name: row.name, lat: Number(row.lat), lng: Number(row.lng), sequence: row.sequence };
}
function mapPassenger(row: any) {
  return {
    id: row.id, organizationId: row.organization_id, name: row.name,
    guardianName: row.guardian_name, guardianPhone: row.guardian_phone,
    pickupStopId: row.pickup_stop_id || undefined, dropStopId: row.drop_stop_id || undefined,
  };
}
function mapTrip(row: any) {
  return {
    id: row.id, organizationId: row.organization_id, driverId: row.driver_id, name: row.name,
    direction: row.direction, scheduledStartTime: row.scheduled_start_time, scheduledEndTime: row.scheduled_end_time,
    status: row.status, actualStartAt: row.actual_start_at || undefined, actualEndAt: row.actual_end_at || undefined,
    liveLat: row.live_lat != null ? Number(row.live_lat) : undefined,
    liveLng: row.live_lng != null ? Number(row.live_lng) : undefined,
    liveUpdatedAt: row.live_updated_at || undefined,
  };
}
function mapTripPassenger(row: any) {
  return { id: row.id, tripId: row.trip_id, passengerId: row.passenger_id, status: row.status, pickedAt: row.picked_at || undefined };
}
function mapNotification(row: any) {
  return { id: row.id, guardianPhone: row.guardian_phone, tripId: row.trip_id || undefined, passengerId: row.passenger_id || undefined, type: row.type, text: row.text, read: row.read, createdAt: row.created_at };
}

async function pushGuardianNotif(guardianPhone: string, type: string, text: string, tripId?: string, passengerId?: string) {
  await query(
    `INSERT INTO saferide360_notifications (guardian_phone, trip_id, passenger_id, type, text) VALUES ($1,$2,$3,$4,$5)`,
    [guardianPhone, tripId || null, passengerId || null, type, text]
  );
  // Best-effort — a guardian without WhatsApp configured server-side still
  // gets the in-app notification row above; this just adds real delivery
  // when ENABLE_WHATSAPP is on.
  try {
    const result = await sendWhatsAppText(guardianPhone, text);
    if (!result.sent && !result.skipped) logger.warn(`SafeRide360 WhatsApp send failed for ${guardianPhone}: ${result.error}`);
  } catch (e: any) {
    logger.warn(`SafeRide360 WhatsApp send threw: ${e.message}`);
  }
}

// ══════════════════════ DRIVER AUTH ══════════════════════════
// Driver registration auto-creates (or reuses) the organization by name —
// matches the spec's "driver just types School Name" simplicity; no
// separate org-admin signup step for MVP.
saferide360Router.post('/auth/driver/register', async (req, res) => {
  try {
    const { name, phone, password, vehicle_number, vehicle_type, organization_name, org_type } = req.body as {
      name?: string; phone?: string; password?: string; vehicle_number?: string; vehicle_type?: string; organization_name?: string; org_type?: string;
    };
    if (!name?.trim() || !phone?.trim() || !password?.trim() || !organization_name?.trim()) {
      fail(res, 'name, phone, password and organization_name are required'); return;
    }
    const normPhone = normalizeWhatsAppPhone(phone);
    const existing = await queryOne<any>('SELECT id FROM saferide360_drivers WHERE phone=$1', [normPhone]);
    if (existing) { fail(res, 'Phone already registered'); return; }

    const type = org_type || 'school';
    let org = await queryOne<any>('SELECT * FROM saferide360_organizations WHERE name=$1 AND org_type=$2', [organization_name.trim(), type]);
    if (!org) {
      [org] = await query<any>(`INSERT INTO saferide360_organizations (name, org_type) VALUES ($1,$2) RETURNING *`, [organization_name.trim(), type]);
    }

    const hash = await bcrypt.hash(password, 10);
    const [driver] = await query<any>(
      `INSERT INTO saferide360_drivers (organization_id, name, phone, password_hash, vehicle_number, vehicle_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [org.id, name.trim(), normPhone, hash, vehicle_number || '', vehicle_type || 'van']
    );
    const token = jwt.sign({ sub: driver.id, role: 'driver', scope: 'saferide360' }, JWT_SECRET, driverSignOptions);
    ok(res, { token, driver: mapDriver(driver), organization: mapOrg(org) }, 201);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.post('/auth/driver/login', async (req, res) => {
  try {
    const { phone, password } = req.body as { phone?: string; password?: string };
    if (!phone?.trim() || !password?.trim()) { fail(res, 'phone and password are required'); return; }
    const normPhone = normalizeWhatsAppPhone(phone);
    const driver = await queryOne<any>('SELECT * FROM saferide360_drivers WHERE phone=$1', [normPhone]);
    if (!driver) { fail(res, 'Invalid phone or password', 401); return; }
    const valid = await bcrypt.compare(password, driver.password_hash);
    if (!valid) { fail(res, 'Invalid phone or password', 401); return; }
    await query('UPDATE saferide360_drivers SET last_login_at=NOW() WHERE id=$1', [driver.id]);
    const token = jwt.sign({ sub: driver.id, role: 'driver', scope: 'saferide360' }, JWT_SECRET, driverSignOptions);
    const org = await queryOne<any>('SELECT * FROM saferide360_organizations WHERE id=$1', [driver.organization_id]);
    ok(res, { token, driver: mapDriver(driver), organization: org ? mapOrg(org) : null });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.get('/auth/driver/me', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const driver = await queryOne<any>('SELECT * FROM saferide360_drivers WHERE id=$1', [req.srUser!.sub]);
    if (!driver) { fail(res, 'Driver not found', 404); return; }
    const org = await queryOne<any>('SELECT * FROM saferide360_organizations WHERE id=$1', [driver.organization_id]);
    ok(res, { driver: mapDriver(driver), organization: org ? mapOrg(org) : null });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// Vehicle registration/type were captured at driver registration — this
// lets a driver correct/update them afterward (e.g. a vehicle swap)
// without re-registering.
saferide360Router.patch('/auth/driver/vehicle', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const { vehicle_number, vehicle_type } = req.body as { vehicle_number?: string; vehicle_type?: string };
    if (vehicle_type && !['auto', 'van', 'bus', 'car'].includes(vehicle_type)) { fail(res, 'vehicle_type must be one of auto, van, bus, car'); return; }
    const [driver] = await query<any>(
      `UPDATE saferide360_drivers SET vehicle_number=COALESCE($1,vehicle_number), vehicle_type=COALESCE($2,vehicle_type) WHERE id=$3 RETURNING *`,
      [vehicle_number, vehicle_type, req.srUser!.sub]
    );
    if (!driver) { fail(res, 'Driver not found', 404); return; }
    ok(res, mapDriver(driver));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// Package plan: INR 100/passenger/month (org-configurable rate). Shows the
// driver dashboard exactly what they're paying for and when the free trial
// ends — no surprise paywall at Start Trip.
saferide360Router.get('/organization/billing', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const driver = await queryOne<any>('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser!.sub]);
    const org = await queryOne<any>('SELECT * FROM saferide360_organizations WHERE id=$1', [driver.organization_id]);
    if (!org) { fail(res, 'Organization not found', 404); return; }
    const passengerCount = await queryOne<any>('SELECT COUNT(*)::int AS n FROM saferide360_passengers WHERE organization_id=$1', [driver.organization_id]);
    ok(res, {
      organization: mapOrg(org),
      passengerCount: passengerCount.n,
      monthlyCost: passengerCount.n * org.plan_rate_inr_per_passenger,
      isActive: isSubscriptionActive(org),
      inTrial: new Date(org.trial_ends_at).getTime() > Date.now(),
    });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ══════════════════════ GUARDIAN AUTH (WhatsApp OTP) ═════════════════════
// "Parent does not create an account" — a guardian's identity is just the
// set of passengers whose guardian_phone matches their OTP-verified
// number, looked up fresh on every request. Isolated OTP table (see
// migration 077) — dedicated rate-limit/expiry, not the generic
// otp_verifications table used elsewhere for a different purpose.
function genOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

saferide360Router.post('/auth/guardian/send-otp', async (req, res) => {
  try {
    const { phone } = req.body as { phone?: string };
    if (!phone?.trim()) { fail(res, 'phone is required'); return; }
    const normPhone = normalizeWhatsAppPhone(phone);

    const linked = await queryOne<any>('SELECT 1 FROM saferide360_passengers WHERE guardian_phone=$1 LIMIT 1', [normPhone]);
    if (!linked) { fail(res, 'This number is not linked to any child on SafeRide360 — ask your driver to add it.', 404); return; }

    const existing = await queryOne<any>('SELECT created_at FROM saferide360_otp WHERE phone=$1', [normPhone]);
    if (existing && Date.now() - new Date(existing.created_at).getTime() < 60000) {
      fail(res, 'Please wait before requesting another code'); return;
    }

    const otp = genOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await query(
      `INSERT INTO saferide360_otp (phone, otp_code, expires_at) VALUES ($1,$2,$3)
       ON CONFLICT (phone) DO UPDATE SET otp_code=$2, expires_at=$3, verified_at=NULL, created_at=NOW()`,
      [normPhone, otp, expiresAt]
    );

    const result = await sendWhatsAppText(normPhone, `🔐 *SafeRide360 Verification*\n\nYour code is: *${otp}*\n\n_Expires in 10 minutes. Do not share this with anyone._`);
    if (!result.sent && !result.skipped) { fail(res, result.error || 'Failed to send the verification code'); return; }
    ok(res, { sent: true, skipped: result.skipped || false, hint: result.skipped ? 'WhatsApp not configured on this server — code logged server-side for dev testing' : undefined });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.post('/auth/guardian/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body as { phone?: string; otp?: string };
    if (!phone?.trim() || !otp?.trim()) { fail(res, 'phone and otp are required'); return; }
    const normPhone = normalizeWhatsAppPhone(phone);

    const row = await queryOne<any>('SELECT * FROM saferide360_otp WHERE phone=$1', [normPhone]);
    if (!row) { fail(res, 'Code not found — request a new one', 404); return; }
    if (row.verified_at) { fail(res, 'Code already used — request a new one'); return; }
    if (new Date(row.expires_at) < new Date()) { fail(res, 'Code expired — request a new one'); return; }
    if (row.otp_code !== otp.trim()) { fail(res, 'Incorrect code'); return; }

    await query('UPDATE saferide360_otp SET verified_at=NOW() WHERE phone=$1', [normPhone]);
    const token = jwt.sign({ sub: normPhone, role: 'guardian', scope: 'saferide360' }, JWT_SECRET, guardianSignOptions);
    ok(res, { token, phone: normPhone });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ══════════════════════ STOPS ═══════════════════════════════════════════
saferide360Router.get('/stops', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const driver = await queryOne<any>('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser!.sub]);
    const rows = await query<any>('SELECT * FROM saferide360_stops WHERE organization_id=$1 ORDER BY sequence ASC', [driver.organization_id]);
    ok(res, rows.map(mapStop));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.post('/stops', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const { name, lat, lng, sequence } = req.body as { name?: string; lat?: number; lng?: number; sequence?: number };
    if (!name?.trim() || lat == null || lng == null) { fail(res, 'name, lat and lng are required'); return; }
    const driver = await queryOne<any>('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser!.sub]);
    const [row] = await query<any>(
      `INSERT INTO saferide360_stops (organization_id, name, lat, lng, sequence) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [driver.organization_id, name.trim(), lat, lng, sequence ?? 0]
    );
    ok(res, mapStop(row), 201);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.patch('/stops/:id', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const { name, lat, lng, sequence } = req.body as { name?: string; lat?: number; lng?: number; sequence?: number };
    const driver = await queryOne<any>('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser!.sub]);
    const [row] = await query<any>(
      `UPDATE saferide360_stops SET name=COALESCE($1,name), lat=COALESCE($2,lat), lng=COALESCE($3,lng), sequence=COALESCE($4,sequence)
       WHERE id=$5 AND organization_id=$6 RETURNING *`,
      [name, lat, lng, sequence, req.params.id, driver.organization_id]
    );
    if (!row) { fail(res, 'Stop not found', 404); return; }
    ok(res, mapStop(row));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.delete('/stops/:id', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const driver = await queryOne<any>('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser!.sub]);
    await query('DELETE FROM saferide360_stops WHERE id=$1 AND organization_id=$2', [req.params.id, driver.organization_id]);
    ok(res, { deleted: true });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ══════════════════════ PASSENGERS ═══════════════════════════════════════
saferide360Router.get('/passengers', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const driver = await queryOne<any>('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser!.sub]);
    const rows = await query<any>('SELECT * FROM saferide360_passengers WHERE organization_id=$1 ORDER BY created_at ASC', [driver.organization_id]);
    ok(res, rows.map(mapPassenger));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.post('/passengers', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const { name, guardian_name, guardian_phone, pickup_stop_id, drop_stop_id } = req.body as {
      name?: string; guardian_name?: string; guardian_phone?: string; pickup_stop_id?: string; drop_stop_id?: string;
    };
    if (!name?.trim() || !guardian_name?.trim() || !guardian_phone?.trim()) {
      fail(res, 'name, guardian_name and guardian_phone are required'); return;
    }
    const driver = await queryOne<any>('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser!.sub]);
    const [row] = await query<any>(
      `INSERT INTO saferide360_passengers (organization_id, name, guardian_name, guardian_phone, pickup_stop_id, drop_stop_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [driver.organization_id, name.trim(), guardian_name.trim(), normalizeWhatsAppPhone(guardian_phone), pickup_stop_id || null, drop_stop_id || null]
    );
    ok(res, mapPassenger(row), 201);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.patch('/passengers/:id', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const { name, guardian_name, guardian_phone, pickup_stop_id, drop_stop_id } = req.body as {
      name?: string; guardian_name?: string; guardian_phone?: string; pickup_stop_id?: string; drop_stop_id?: string;
    };
    const driver = await queryOne<any>('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser!.sub]);
    const [row] = await query<any>(
      `UPDATE saferide360_passengers SET
         name=COALESCE($1,name), guardian_name=COALESCE($2,guardian_name),
         guardian_phone=COALESCE($3,guardian_phone), pickup_stop_id=COALESCE($4,pickup_stop_id), drop_stop_id=COALESCE($5,drop_stop_id)
       WHERE id=$6 AND organization_id=$7 RETURNING *`,
      [name, guardian_name, guardian_phone ? normalizeWhatsAppPhone(guardian_phone) : null, pickup_stop_id, drop_stop_id, req.params.id, driver.organization_id]
    );
    if (!row) { fail(res, 'Passenger not found', 404); return; }
    ok(res, mapPassenger(row));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.delete('/passengers/:id', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const driver = await queryOne<any>('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser!.sub]);
    await query('DELETE FROM saferide360_passengers WHERE id=$1 AND organization_id=$2', [req.params.id, driver.organization_id]);
    ok(res, { deleted: true });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ══════════════════════ TRIPS ═════════════════════════════════════════════
saferide360Router.get('/trips', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const rows = await query<any>('SELECT * FROM saferide360_trips WHERE driver_id=$1 ORDER BY created_at DESC', [req.srUser!.sub]);
    ok(res, rows.map(mapTrip));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.post('/trips', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const { name, direction, scheduled_start_time, scheduled_end_time } = req.body as {
      name?: string; direction?: 'pickup' | 'drop'; scheduled_start_time?: string; scheduled_end_time?: string;
    };
    if (!name?.trim() || !scheduled_start_time || !scheduled_end_time) {
      fail(res, 'name, scheduled_start_time and scheduled_end_time are required'); return;
    }
    const driver = await queryOne<any>('SELECT organization_id FROM saferide360_drivers WHERE id=$1', [req.srUser!.sub]);
    const [row] = await query<any>(
      `INSERT INTO saferide360_trips (organization_id, driver_id, name, direction, scheduled_start_time, scheduled_end_time)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [driver.organization_id, req.srUser!.sub, name.trim(), direction || 'pickup', scheduled_start_time, scheduled_end_time]
    );
    ok(res, mapTrip(row), 201);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.patch('/trips/:id', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const { name, scheduled_start_time, scheduled_end_time } = req.body as { name?: string; scheduled_start_time?: string; scheduled_end_time?: string };
    const [row] = await query<any>(
      `UPDATE saferide360_trips SET name=COALESCE($1,name), scheduled_start_time=COALESCE($2,scheduled_start_time), scheduled_end_time=COALESCE($3,scheduled_end_time)
       WHERE id=$4 AND driver_id=$5 RETURNING *`,
      [name, scheduled_start_time, scheduled_end_time, req.params.id, req.srUser!.sub]
    );
    if (!row) { fail(res, 'Trip not found', 404); return; }
    ok(res, mapTrip(row));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// Seeds today's trip_passengers from every passenger whose relevant stop
// (pickup for a 'pickup' trip, drop for a 'drop' trip) belongs to this
// organization — one row per passenger, fresh each time a trip starts
// (matches the 2-day-retention design: this is ephemeral daily state, not
// master data).
saferide360Router.post('/trips/:id/start', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const trip = await queryOne<any>('SELECT * FROM saferide360_trips WHERE id=$1 AND driver_id=$2', [req.params.id, req.srUser!.sub]);
    if (!trip) { fail(res, 'Trip not found', 404); return; }
    if (trip.status === 'active') { fail(res, 'Trip is already active'); return; }

    const org = await queryOne<any>('SELECT * FROM saferide360_organizations WHERE id=$1', [trip.organization_id]);
    if (!isSubscriptionActive(org)) {
      const passengerCount = await queryOne<any>('SELECT COUNT(*)::int AS n FROM saferide360_passengers WHERE organization_id=$1', [trip.organization_id]);
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
    const passengers = await query<any>(
      `SELECT * FROM saferide360_passengers WHERE organization_id=$1 AND ${stopCol} IS NOT NULL`,
      [trip.organization_id]
    );
    for (const p of passengers) {
      await query(`INSERT INTO saferide360_trip_passengers (trip_id, passenger_id) VALUES ($1,$2)`, [trip.id, p.id]);
    }

    const [updated] = await query<any>(
      `UPDATE saferide360_trips SET status='active', actual_start_at=NOW() WHERE id=$1 RETURNING *`,
      [trip.id]
    );

    const driver = await queryOne<any>('SELECT * FROM saferide360_drivers WHERE id=$1', [req.srUser!.sub]);
    for (const p of passengers) {
      await pushGuardianNotif(
        p.guardian_phone,
        'trip_started',
        `🚐 *${trip.name}* has started.\n\nDriver: ${driver.name}\nVehicle: ${driver.vehicle_number}\n\nTrack live in SafeRide360.`,
        trip.id, p.id
      );
    }

    ok(res, mapTrip(updated));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// Driver's device calls this every ~5-10s while a trip is active — matches
// the exact polling pattern the existing Ride360 module already uses
// (PATCH .../live), rather than introducing WebSockets/pub-sub for a
// slow-moving vehicle.
saferide360Router.patch('/trips/:id/live', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const { lat, lng } = req.body as { lat?: number; lng?: number };
    if (lat == null || lng == null) { fail(res, 'lat and lng are required'); return; }
    const [row] = await query<any>(
      `UPDATE saferide360_trips SET live_lat=$1, live_lng=$2, live_updated_at=NOW() WHERE id=$3 AND driver_id=$4 AND status='active' RETURNING *`,
      [lat, lng, req.params.id, req.srUser!.sub]
    );
    if (!row) { fail(res, 'Active trip not found', 404); return; }
    await query(`INSERT INTO saferide360_gps_pings (trip_id, lat, lng) VALUES ($1,$2,$3)`, [row.id, lat, lng]);
    ok(res, mapTrip(row));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.get('/trips/:id/passengers', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const rows = await query<any>(
      `SELECT tp.*, p.name AS passenger_name, p.guardian_phone
       FROM saferide360_trip_passengers tp JOIN saferide360_passengers p ON p.id = tp.passenger_id
       WHERE tp.trip_id=$1 ORDER BY p.name ASC`,
      [req.params.id]
    );
    ok(res, rows.map((r: any) => ({ ...mapTripPassenger(r), passengerName: r.passenger_name })));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// status: 'picked' | 'absent' — a third state beyond picked/pending so an
// absent child doesn't sit as "pending" forever and read as a stuck trip
// to an anxious parent.
saferide360Router.patch('/trip-passengers/:id', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const { status } = req.body as { status?: 'picked' | 'absent' };
    if (!status || !['picked', 'absent'].includes(status)) { fail(res, "status must be 'picked' or 'absent'"); return; }

    const [row] = await query<any>(
      `UPDATE saferide360_trip_passengers SET status=$1, picked_at=CASE WHEN $1::VARCHAR='picked' THEN NOW() ELSE picked_at END WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    );
    if (!row) { fail(res, 'Trip passenger not found', 404); return; }

    const p = await queryOne<any>('SELECT * FROM saferide360_passengers WHERE id=$1', [row.passenger_id]);
    if (p) {
      const text = status === 'picked'
        ? `✅ *${p.name}* has boarded the vehicle.\n\nTime: ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
        : `ℹ️ *${p.name}* marked absent for today's trip.`;
      await pushGuardianNotif(p.guardian_phone, status === 'picked' ? 'student_picked' : 'student_absent', text, row.trip_id, p.id);
    }
    ok(res, mapTripPassenger(row));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.post('/trips/:id/complete', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const trip = await queryOne<any>('SELECT * FROM saferide360_trips WHERE id=$1 AND driver_id=$2', [req.params.id, req.srUser!.sub]);
    if (!trip) { fail(res, 'Trip not found', 404); return; }

    const [updated] = await query<any>(
      `UPDATE saferide360_trips SET status='completed', actual_end_at=NOW() WHERE id=$1 RETURNING *`,
      [trip.id]
    );

    const passengers = await query<any>(
      `SELECT tp.*, p.name AS passenger_name, p.guardian_phone
       FROM saferide360_trip_passengers tp JOIN saferide360_passengers p ON p.id = tp.passenger_id
       WHERE tp.trip_id=$1 AND tp.status='picked'`,
      [trip.id]
    );
    const arrivalText = trip.direction === 'drop' ? 'reached home safely' : 'reached school safely';
    for (const p of passengers) {
      await pushGuardianNotif(p.guardian_phone, 'trip_completed', `🏁 *${p.passenger_name}* has ${arrivalText}.`, trip.id, p.passenger_id);
    }

    ok(res, mapTrip(updated));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// Driver-facing SOS — cheap to have in MVP (just another WhatsApp broadcast
// + notification rows), matching the product's own "are they safe?"
// guiding principle rather than deferring it to "future."
// Shared by SOS and the general trip-alert broadcast below — both are the
// exact same delivery mechanism (every guardian with a passenger on this
// specific trip, and only this trip), just different urgency/type tagging.
async function broadcastToTripGuardians(tripId: string, type: string, text: string): Promise<number> {
  const passengers = await query<any>(
    `SELECT p.* FROM saferide360_trip_passengers tp JOIN saferide360_passengers p ON p.id = tp.passenger_id WHERE tp.trip_id=$1`,
    [tripId]
  );
  for (const p of passengers) {
    await pushGuardianNotif(p.guardian_phone, type, text, tripId, p.id);
  }
  return passengers.length;
}

saferide360Router.post('/trips/:id/sos', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const trip = await queryOne<any>('SELECT * FROM saferide360_trips WHERE id=$1 AND driver_id=$2', [req.params.id, req.srUser!.sub]);
    if (!trip) { fail(res, 'Trip not found', 404); return; }
    const driver = await queryOne<any>('SELECT * FROM saferide360_drivers WHERE id=$1', [req.srUser!.sub]);
    const alerted = await broadcastToTripGuardians(trip.id, 'sos', `🚨 *Emergency alert* on ${trip.name} — driver ${driver.name} (${driver.vehicle_number}) has raised an SOS. Please contact the school immediately.`);
    ok(res, { alerted });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// Driver-authored update — vehicle issue / traffic / delay / anything else
// worth telling every parent on this specific trip, typed or (client-side)
// transcribed from a voice recording. Not an emergency — same delivery
// mechanism as SOS, lower urgency framing.
const ALERT_TYPE_LABELS: Record<string, string> = {
  delay: '⏰ Delay',
  traffic: '🚦 Traffic',
  vehicle_issue: '🔧 Vehicle Issue',
  custom: '📢 Update',
};
saferide360Router.post('/trips/:id/alert', srAuth, requireDriver, async (req: SRReq, res) => {
  try {
    const { message, alert_type } = req.body as { message?: string; alert_type?: string };
    if (!message?.trim()) { fail(res, 'message is required'); return; }
    const trip = await queryOne<any>('SELECT * FROM saferide360_trips WHERE id=$1 AND driver_id=$2', [req.params.id, req.srUser!.sub]);
    if (!trip) { fail(res, 'Trip not found', 404); return; }
    const driver = await queryOne<any>('SELECT * FROM saferide360_drivers WHERE id=$1', [req.srUser!.sub]);

    const type = alert_type && ALERT_TYPE_LABELS[alert_type] ? alert_type : 'custom';
    const label = ALERT_TYPE_LABELS[type];
    const text = `${label} — *${trip.name}*\n\n${message.trim()}\n\n— ${driver.name}, ${driver.vehicle_number}`;
    const alerted = await broadcastToTripGuardians(trip.id, 'trip_alert', text);
    ok(res, { alerted });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ══════════════════════ GUARDIAN VIEWS ═══════════════════════════════════
saferide360Router.get('/guardian/children', srAuth, requireGuardian, async (req: SRReq, res) => {
  try {
    const rows = await query<any>('SELECT * FROM saferide360_passengers WHERE guardian_phone=$1', [req.srUser!.sub]);
    ok(res, rows.map(mapPassenger));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// Today's trip status for every one of this guardian's children — may span
// multiple trips/drivers/organizations if they have kids at different
// stops or schools.
saferide360Router.get('/guardian/today', srAuth, requireGuardian, async (req: SRReq, res) => {
  try {
    const rows = await query<any>(
      `SELECT tp.*, p.name AS passenger_name, p.pickup_stop_id, p.drop_stop_id,
              t.id AS trip_id_full, t.name AS trip_name, t.status AS trip_status, t.direction,
              t.live_lat, t.live_lng, t.live_updated_at, t.actual_start_at,
              d.name AS driver_name, d.phone AS driver_phone, d.vehicle_number, d.vehicle_type
       FROM saferide360_trip_passengers tp
       JOIN saferide360_passengers p ON p.id = tp.passenger_id
       JOIN saferide360_trips t ON t.id = tp.trip_id
       JOIN saferide360_drivers d ON d.id = t.driver_id
       WHERE p.guardian_phone=$1 AND t.created_at >= NOW() - INTERVAL '2 days'
       ORDER BY t.created_at DESC`,
      [req.srUser!.sub]
    );
    ok(res, rows.map((r: any) => ({
      tripPassengerId: r.id, passengerId: r.passenger_id, passengerName: r.passenger_name, status: r.status, pickedAt: r.picked_at || undefined,
      tripId: r.trip_id_full, tripName: r.trip_name, tripStatus: r.trip_status, direction: r.direction,
      liveLat: r.live_lat != null ? Number(r.live_lat) : undefined, liveLng: r.live_lng != null ? Number(r.live_lng) : undefined, liveUpdatedAt: r.live_updated_at || undefined,
      driverName: r.driver_name, driverPhone: r.driver_phone, vehicleNumber: r.vehicle_number, vehicleType: r.vehicle_type,
    })));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.get('/guardian/trips/:id/stops', srAuth, requireGuardian, async (req: SRReq, res) => {
  try {
    const trip = await queryOne<any>('SELECT * FROM saferide360_trips WHERE id=$1', [req.params.id]);
    if (!trip) { fail(res, 'Trip not found', 404); return; }
    const stops = await query<any>('SELECT * FROM saferide360_stops WHERE organization_id=$1 ORDER BY sequence ASC', [trip.organization_id]);
    ok(res, stops.map(mapStop));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.get('/guardian/notifications', srAuth, requireGuardian, async (req: SRReq, res) => {
  try {
    const rows = await query<any>('SELECT * FROM saferide360_notifications WHERE guardian_phone=$1 ORDER BY created_at DESC LIMIT 100', [req.srUser!.sub]);
    ok(res, rows.map(mapNotification));
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

saferide360Router.patch('/guardian/notifications/read-all', srAuth, requireGuardian, async (req: SRReq, res) => {
  try {
    await query('UPDATE saferide360_notifications SET read=TRUE WHERE guardian_phone=$1 AND read=FALSE', [req.srUser!.sub]);
    ok(res, { updated: true });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── LIVE LOCATION UPDATES (every 10 min, while a trip is active) ─────────
// Separate from the ~7s live_lat/live_lng polling that drives the map —
// this is an explicit push notification so a parent who isn't looking at
// the app still hears "here's where the vehicle is" periodically. The
// interval and the type-specific retention below are both named constants
// ("do the setting for sending and cleaning"), not magic numbers.
const LOCATION_UPDATE_INTERVAL_MS = 10 * 60_000;
const LOCATION_UPDATE_RETENTION_DAYS = 1; // shorter than the 2-day default for every other notification type — these are high-frequency and low-value after the fact
const OTHER_NOTIFICATION_RETENTION_DAYS = 2;

export async function runSafeRide360LocationUpdateJob() {
  try {
    const activeTrips = await query<any>(
      `SELECT t.*, d.name AS driver_name, d.vehicle_number
       FROM saferide360_trips t JOIN saferide360_drivers d ON d.id = t.driver_id
       WHERE t.status='active' AND t.live_lat IS NOT NULL AND t.live_lng IS NOT NULL`
    );
    let sent = 0;
    for (const trip of activeTrips) {
      const mapsLink = `https://www.google.com/maps?q=${trip.live_lat},${trip.live_lng}`;
      const text = `📍 *${trip.name}* location update\n\n${driverLabelFor(trip)}\nCurrent location: ${mapsLink}\nLast updated: ${new Date(trip.live_updated_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
      sent += await broadcastToTripGuardians(trip.id, 'location_update', text);
    }
    if (activeTrips.length) logger.info(`[SafeRide360:location] Sent location updates for ${activeTrips.length} active trip(s), ${sent} notification(s)`);
  } catch (e: any) {
    logger.error(`[SafeRide360:location] Job failed: ${e.message}`);
  }
}
function driverLabelFor(trip: any): string {
  return `Driver: ${trip.driver_name} · Vehicle: ${trip.vehicle_number}`;
}

// ── RETENTION ──────────────────────────────────────────────────────────────
// Ephemeral daily/trip data only — passenger/stop/organization/driver
// master data is never touched. Wired into the existing background-service
// setInterval pattern (backend/src/modules/public/background.service.ts),
// not a new cron dependency.
export async function runSafeRide360RetentionJob() {
  try {
    const gps = await query<any>(`DELETE FROM saferide360_gps_pings WHERE recorded_at < NOW() - INTERVAL '${OTHER_NOTIFICATION_RETENTION_DAYS} days' RETURNING id`);
    const locNotif = await query<any>(`DELETE FROM saferide360_notifications WHERE type='location_update' AND created_at < NOW() - INTERVAL '${LOCATION_UPDATE_RETENTION_DAYS} days' RETURNING id`);
    const notif = await query<any>(`DELETE FROM saferide360_notifications WHERE type != 'location_update' AND created_at < NOW() - INTERVAL '${OTHER_NOTIFICATION_RETENTION_DAYS} days' RETURNING id`);
    const tp = await query<any>(`DELETE FROM saferide360_trip_passengers WHERE created_at < NOW() - INTERVAL '${OTHER_NOTIFICATION_RETENTION_DAYS} days' RETURNING id`);
    const trips = await query<any>(`DELETE FROM saferide360_trips WHERE status='completed' AND actual_end_at < NOW() - INTERVAL '${OTHER_NOTIFICATION_RETENTION_DAYS} days' RETURNING id`);
    if (gps.length || locNotif.length || notif.length || tp.length || trips.length) {
      logger.info(`[SafeRide360:retention] purged gps=${gps.length} location_notifications=${locNotif.length} other_notifications=${notif.length} trip_passengers=${tp.length} trips=${trips.length}`);
    }
  } catch (e: any) {
    logger.error(`[SafeRide360:retention] Job failed: ${e.message}`);
  }
}
