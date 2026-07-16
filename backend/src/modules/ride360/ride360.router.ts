// ============================================================
// ride360.router.ts — Ride360 driver/customer marketplace API
// Mounted at /v1/ride360 in app.ts
// Auth: own JWT scope='ride360', role='driver'|'customer', same secret as main app
//
// Response shapes are mapped from snake_case DB columns to the exact
// camelCase fields the existing Ride360 frontend already expects (Ride,
// CustomerRequest, DriverProfile, CustomerProfile, FuelLog, AppNotification),
// so the frontend's types don't change — only its data source does.
// ============================================================
import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import { query, queryOne, withTransaction, runMigrations } from '../../config/db';

export const ride360Router = Router();

// ── Config ───────────────────────────────────────────────────
const JWT_SECRET: Secret = (process.env.JWT_SECRET || 'dev-secret-change-this') as Secret;
const signOptions: SignOptions = { expiresIn: 30 * 24 * 3600 }; // 30 days — matches the "stay logged in" feel of a driver/customer app

// ── Helpers ──────────────────────────────────────────────────
function ok(res: Response, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: Response, message: string, status = 400) {
  res.status(status).json({ success: false, error: message, timestamp: new Date().toISOString() });
}
function makeToken(id: string, role: 'driver' | 'customer') {
  return jwt.sign({ sub: id, role, scope: 'ride360' }, JWT_SECRET, signOptions);
}

interface R360Req extends Request { ride360User?: { sub: string; role: 'driver' | 'customer' } }

function ride360Auth(req: R360Req, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
  try {
    const decoded: any = jwt.verify(header.slice(7), JWT_SECRET);
    if (decoded.scope !== 'ride360') { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
    req.ride360User = { sub: decoded.sub, role: decoded.role };
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Token expired or invalid' });
  }
}
function requireDriver(req: R360Req, res: Response, next: NextFunction) {
  if (req.ride360User?.role !== 'driver') { res.status(403).json({ success: false, error: 'Driver account required' }); return; }
  next();
}
function requireCustomer(req: R360Req, res: Response, next: NextFunction) {
  if (req.ride360User?.role !== 'customer') { res.status(403).json({ success: false, error: 'Customer account required' }); return; }
  next();
}

// ── Row -> frontend-shape mappers ─────────────────────────────
function mapDriver(row: any) {
  return {
    id: row.id, name: row.name, email: row.email || undefined, phone: row.phone || undefined,
    authMethod: row.auth_method, vehicleType: row.vehicle_type, vehicleNumber: row.vehicle_number,
    licenseNumber: row.license_number, licenseExpiry: row.license_expiry ? String(row.license_expiry).slice(0, 10) : '',
    piggyBalance: Number(row.piggy_balance), piggyPct: row.piggy_pct,
    createdAt: row.created_at, profileComplete: row.profile_complete,
    subscriptionPlan: row.subscription_plan,
  };
}
function mapCustomer(row: any) {
  return { id: row.id, phone: row.phone, createdAt: row.created_at, subscriptionPlan: row.subscription_plan };
}
function mapRide(row: any) {
  return {
    id: row.id, driverId: row.driver_id, kind: row.kind, provider: row.provider || undefined,
    source: row.source, destination: row.destination, status: row.status,
    fare: row.fare != null ? Number(row.fare) : undefined,
    distanceKm: Number(row.distance_km), durationMin: row.duration_min,
    piggyContribution: Number(row.piggy_contribution),
    startedAt: row.started_at, endedAt: row.ended_at || undefined,
    costAnalysis: row.cost_analysis || undefined,
    odometerStartKm: row.odometer_start_km != null ? Number(row.odometer_start_km) : undefined,
    odometerEndKm: row.odometer_end_km != null ? Number(row.odometer_end_km) : undefined,
    matchedRequestId: row.matched_request_id || undefined,
    liveLat: row.live_lat != null ? Number(row.live_lat) : undefined,
    liveLng: row.live_lng != null ? Number(row.live_lng) : undefined,
    liveUpdatedAt: row.live_updated_at || undefined,
  };
}
function mapRequest(row: any) {
  return {
    id: row.id, customerId: row.customer_id, customerPhone: row.customer_phone, type: row.type,
    pickup: row.pickup, drop: row.drop_point, description: row.description,
    offeredAmount: Number(row.offered_amount), currentAmount: Number(row.current_amount),
    status: row.status, claimedByDriverId: row.claimed_by_driver_id || undefined,
    originEmptyRideId: row.origin_empty_ride_id || undefined,
    contactInitiatedBy: row.contact_initiated_by || undefined,
    messages: row.messages || [], createdAt: row.created_at,
  };
}
function mapFuelLog(row: any) {
  return { id: row.id, driverId: row.driver_id, date: String(row.date).slice(0, 10), liters: Number(row.liters), totalCost: Number(row.total_cost), odometerKm: Number(row.odometer_km), createdAt: row.created_at };
}
function mapNotification(row: any) {
  return { id: row.id, forType: row.for_type, forId: row.for_id, type: row.type, text: row.text, requestId: row.request_id || undefined, read: row.read, createdAt: row.created_at };
}

async function pushNotif(forType: 'driver' | 'customer', forId: string, type: string, text: string, requestId?: string) {
  await query(`INSERT INTO ride360_notifications (for_type, for_id, type, text, request_id) VALUES ($1,$2,$3,$4,$5)`, [forType, forId, type, text, requestId || null]);
}

async function findReferrer(id: string): Promise<{ type: 'driver' | 'customer'; name: string } | null> {
  const d = await queryOne<any>('SELECT name FROM ride360_drivers WHERE id=$1', [id]);
  if (d) return { type: 'driver', name: d.name };
  const c = await queryOne<any>('SELECT phone FROM ride360_customers WHERE id=$1', [id]);
  if (c) return { type: 'customer', name: c.phone };
  return null;
}
async function recordInviteIfAny(referredBy: string | undefined, invitee: { type: 'driver' | 'customer'; id: string; name: string }) {
  if (!referredBy || referredBy === invitee.id) return;
  const ref = await findReferrer(referredBy);
  if (!ref) return;
  await query(
    `INSERT INTO ride360_invites (referrer_type, referrer_id, referrer_name, invitee_type, invitee_id, invitee_name) VALUES ($1,$2,$3,$4,$5,$6)`,
    [ref.type, referredBy, ref.name, invitee.type, invitee.id, invitee.name]
  );
}

// ── STATUS (diagnostic) ───────────────────────────────────────
ride360Router.get('/status', async (_req, res) => {
  try {
    const tables = await query<any>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'ride360%' ORDER BY tablename`, []);
    const migrations = await query<any>(`SELECT name, run_at FROM _migrations WHERE name LIKE '%ride360%' ORDER BY name`, []);
    ok(res, { tables: tables.map((t: any) => t.tablename), migrations });
  } catch (e: any) { fail(res, e.message, 500); }
});
ride360Router.post('/admin/run-migrations', async (req, res) => {
  if (req.headers['x-admin-key'] !== (process.env.ADMIN_SECRET || 'c360-admin')) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
  try { await runMigrations(); ok(res, { message: 'Migrations complete' }); } catch (e: any) { fail(res, e.message, 500); }
});

// ── AUTH — DRIVER ───────────────────────────────────────────────
ride360Router.post('/auth/driver/register', async (req, res) => {
  try {
    const { name, email, password, vehicleType, phone, referredBy } = req.body;
    if (!name?.trim() || !email?.trim() || !password) { fail(res, 'name, email and password are required'); return; }
    const emailLc = email.toLowerCase().trim();
    const existing = await queryOne<any>('SELECT id FROM ride360_drivers WHERE email=$1', [emailLc]);
    if (existing) { fail(res, 'Email already registered'); return; }
    const hash = await bcrypt.hash(password, 10);
    const [row] = await query<any>(
      `INSERT INTO ride360_drivers (name, email, phone, password_hash, auth_method, vehicle_type, last_login_at)
       VALUES ($1,$2,$3,$4,'email',$5,NOW()) RETURNING *`,
      [name.trim(), emailLc, phone || null, hash, vehicleType || 'auto']
    );
    await recordInviteIfAny(referredBy, { type: 'driver', id: row.id, name: row.name });
    const token = makeToken(row.id, 'driver');
    ok(res, { token, user: mapDriver(row) }, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

ride360Router.post('/auth/driver/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) { fail(res, 'email and password are required'); return; }
    const row = await queryOne<any>('SELECT * FROM ride360_drivers WHERE email=$1', [email.toLowerCase().trim()]);
    if (!row || !row.password_hash) { fail(res, 'No account found with that email', 404); return; }
    const validPw = await bcrypt.compare(password, row.password_hash);
    if (!validPw) { fail(res, 'Incorrect password', 401); return; }
    if (row.is_active === false) { fail(res, 'This account has been suspended — contact support.', 403); return; }
    await query('UPDATE ride360_drivers SET last_login_at=NOW() WHERE id=$1', [row.id]);
    const token = makeToken(row.id, 'driver');
    ok(res, { token, user: mapDriver(row) });
  } catch (e: any) { fail(res, e.message, 500); }
});

ride360Router.post('/auth/driver/social', async (req, res) => {
  try {
    const { method, name, email, referredBy } = req.body;
    if (!method || !name || !email) { fail(res, 'method, name and email are required'); return; }
    let row = await queryOne<any>('SELECT * FROM ride360_drivers WHERE email=$1', [email.toLowerCase().trim()]);
    if (!row) {
      [row] = await query<any>(
        `INSERT INTO ride360_drivers (name, email, auth_method, vehicle_type, last_login_at) VALUES ($1,$2,$3,'auto',NOW()) RETURNING *`,
        [name, email.toLowerCase().trim(), method]
      );
      await recordInviteIfAny(referredBy, { type: 'driver', id: row.id, name: row.name });
    } else {
      if (row.is_active === false) { fail(res, 'This account has been suspended — contact support.', 403); return; }
      await query('UPDATE ride360_drivers SET last_login_at=NOW() WHERE id=$1', [row.id]);
    }
    const token = makeToken(row.id, 'driver');
    ok(res, { token, user: mapDriver(row) });
  } catch (e: any) { fail(res, e.message, 500); }
});

ride360Router.patch('/driver/profile', ride360Auth, requireDriver, async (req: R360Req, res) => {
  try {
    const { vehicleNumber, licenseNumber, licenseExpiry, piggyPct, profileComplete, vehicleType } = req.body;
    const sets: string[] = []; const params: any[] = []; let i = 1;
    if (vehicleNumber !== undefined) { sets.push(`vehicle_number=$${i++}`); params.push(vehicleNumber); }
    if (licenseNumber !== undefined) { sets.push(`license_number=$${i++}`); params.push(licenseNumber); }
    if (licenseExpiry !== undefined) { sets.push(`license_expiry=$${i++}`); params.push(licenseExpiry || null); }
    if (piggyPct !== undefined) { sets.push(`piggy_pct=$${i++}`); params.push(piggyPct); }
    if (vehicleType !== undefined) { sets.push(`vehicle_type=$${i++}`); params.push(vehicleType); }
    if (profileComplete !== undefined) { sets.push(`profile_complete=$${i++}`); params.push(profileComplete); }
    if (sets.length === 0) { fail(res, 'Nothing to update'); return; }
    params.push(req.ride360User!.sub);
    const [row] = await query<any>(`UPDATE ride360_drivers SET ${sets.join(', ')} WHERE id=$${i++} RETURNING *`, params);
    if (!row) { fail(res, 'Driver not found', 404); return; }
    ok(res, mapDriver(row));
  } catch (e: any) { fail(res, e.message, 500); }
});

ride360Router.patch('/driver/piggy-balance', ride360Auth, requireDriver, async (req: R360Req, res) => {
  try {
    const { delta } = req.body as { delta: number };
    if (typeof delta !== 'number') { fail(res, 'delta must be a number'); return; }
    const [row] = await query<any>('UPDATE ride360_drivers SET piggy_balance = piggy_balance + $1 WHERE id=$2 RETURNING *', [delta, req.ride360User!.sub]);
    ok(res, mapDriver(row));
  } catch (e: any) { fail(res, e.message, 500); }
});

// ── AUTH — CUSTOMER ──────────────────────────────────────────────
ride360Router.post('/auth/customer/login', async (req, res) => {
  try {
    const { phone, referredBy } = req.body;
    if (!phone?.trim()) { fail(res, 'phone is required'); return; }
    let row = await queryOne<any>('SELECT * FROM ride360_customers WHERE phone=$1', [phone.trim()]);
    if (!row) {
      [row] = await query<any>(`INSERT INTO ride360_customers (phone, last_login_at) VALUES ($1,NOW()) RETURNING *`, [phone.trim()]);
      await recordInviteIfAny(referredBy, { type: 'customer', id: row.id, name: row.phone });
    } else {
      if (row.is_active === false) { fail(res, 'This account has been suspended — contact support.', 403); return; }
      await query('UPDATE ride360_customers SET last_login_at=NOW() WHERE id=$1', [row.id]);
    }
    const token = makeToken(row.id, 'customer');
    ok(res, { token, user: mapCustomer(row) });
  } catch (e: any) { fail(res, e.message, 500); }
});

ride360Router.get('/auth/me', ride360Auth, async (req: R360Req, res) => {
  try {
    if (req.ride360User!.role === 'driver') {
      const row = await queryOne<any>('SELECT * FROM ride360_drivers WHERE id=$1', [req.ride360User!.sub]);
      if (!row) { fail(res, 'Not found', 404); return; }
      ok(res, { role: 'driver', user: mapDriver(row) });
    } else {
      const row = await queryOne<any>('SELECT * FROM ride360_customers WHERE id=$1', [req.ride360User!.sub]);
      if (!row) { fail(res, 'Not found', 404); return; }
      ok(res, { role: 'customer', user: mapCustomer(row) });
    }
  } catch (e: any) { fail(res, e.message, 500); }
});

// ── RIDES ─────────────────────────────────────────────────────
ride360Router.get('/rides', ride360Auth, requireDriver, async (req: R360Req, res) => {
  try {
    const rows = await query<any>('SELECT * FROM ride360_rides WHERE driver_id=$1 ORDER BY started_at DESC', [req.ride360User!.sub]);
    ok(res, rows.map(mapRide));
  } catch (e: any) { fail(res, e.message, 500); }
});

ride360Router.post('/rides', ride360Auth, requireDriver, async (req: R360Req, res) => {
  try {
    const { kind, provider, source, destination, fare, distanceKm, matchedRequestId } = req.body;
    if (!kind || !source || !destination) { fail(res, 'kind, source and destination are required'); return; }
    const [row] = await query<any>(
      `INSERT INTO ride360_rides (driver_id, kind, provider, source, destination, fare, distance_km, matched_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.ride360User!.sub, kind, provider || null, JSON.stringify(source), JSON.stringify(destination), fare ?? null, distanceKm || 0, matchedRequestId || null]
    );
    ok(res, mapRide(row), 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

ride360Router.patch('/rides/:id/live', ride360Auth, requireDriver, async (req: R360Req, res) => {
  try {
    const { lat, lng } = req.body;
    const [row] = await query<any>(
      `UPDATE ride360_rides SET live_lat=$1, live_lng=$2, live_updated_at=NOW() WHERE id=$3 AND driver_id=$4 RETURNING *`,
      [lat, lng, req.params.id, req.ride360User!.sub]
    );
    if (!row) { fail(res, 'Ride not found', 404); return; }
    ok(res, mapRide(row));
  } catch (e: any) { fail(res, e.message, 500); }
});

// End a ride: status/odometer/cost-analysis, plus piggy top-up and matched-request completion.
ride360Router.patch('/rides/:id/end', ride360Auth, requireDriver, async (req: R360Req, res) => {
  try {
    const { durationMin, odometerEndKm, piggyContribution, costAnalysis } = req.body;
    const result = await withTransaction(async (client) => {
      const rideRes = await client.query('SELECT * FROM ride360_rides WHERE id=$1 AND driver_id=$2', [req.params.id, req.ride360User!.sub]);
      const ride = rideRes.rows[0];
      if (!ride) return null;
      const upd = await client.query(
        `UPDATE ride360_rides SET status='completed', ended_at=NOW(), duration_min=$1, odometer_end_km=$2, piggy_contribution=$3, cost_analysis=$4
         WHERE id=$5 RETURNING *`,
        [durationMin || 0, odometerEndKm ?? null, piggyContribution || 0, costAnalysis ? JSON.stringify(costAnalysis) : null, ride.id]
      );
      const updatedRide = upd.rows[0];
      if (piggyContribution) {
        await client.query('UPDATE ride360_drivers SET piggy_balance = piggy_balance + $1 WHERE id=$2', [piggyContribution, req.ride360User!.sub]);
      }
      let matchedReq: any = null;
      if (ride.matched_request_id) {
        const reqUpd = await client.query(`UPDATE ride360_requests SET status='completed' WHERE id=$1 RETURNING *`, [ride.matched_request_id]);
        matchedReq = reqUpd.rows[0] || null;
      }
      return { ride: updatedRide, matchedReq };
    });
    if (!result) { fail(res, 'Ride not found', 404); return; }
    if (result.matchedReq) {
      await pushNotif('customer', result.matchedReq.customer_id, 'completed', `✅ Your ride is complete — ₹${result.matchedReq.current_amount} via RideConnect360.`, result.matchedReq.id);
    }
    const driverRow = await queryOne<any>('SELECT * FROM ride360_drivers WHERE id=$1', [req.ride360User!.sub]);
    ok(res, { ride: mapRide(result.ride), driver: mapDriver(driverRow) });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ── FUEL LOGS ─────────────────────────────────────────────────
ride360Router.get('/fuel-logs', ride360Auth, requireDriver, async (req: R360Req, res) => {
  try {
    const rows = await query<any>('SELECT * FROM ride360_fuel_logs WHERE driver_id=$1 ORDER BY date DESC, created_at DESC', [req.ride360User!.sub]);
    ok(res, rows.map(mapFuelLog));
  } catch (e: any) { fail(res, e.message, 500); }
});
ride360Router.post('/fuel-logs', ride360Auth, requireDriver, async (req: R360Req, res) => {
  try {
    const { date, liters, totalCost, odometerKm } = req.body;
    if (!date || !liters || !totalCost || !odometerKm) { fail(res, 'date, liters, totalCost and odometerKm are required'); return; }
    const [row] = await query<any>(
      `INSERT INTO ride360_fuel_logs (driver_id, date, liters, total_cost, odometer_km) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.ride360User!.sub, date, liters, totalCost, odometerKm]
    );
    ok(res, mapFuelLog(row), 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

// ── REQUESTS (customer <-> driver marketplace) ───────────────────
ride360Router.get('/requests/mine', ride360Auth, async (req: R360Req, res) => {
  try {
    const rows = req.ride360User!.role === 'driver'
      ? await query<any>('SELECT * FROM ride360_requests WHERE claimed_by_driver_id=$1 ORDER BY created_at DESC', [req.ride360User!.sub])
      : await query<any>('SELECT * FROM ride360_requests WHERE customer_id=$1 ORDER BY created_at DESC', [req.ride360User!.sub]);
    ok(res, rows.map(mapRequest));
  } catch (e: any) { fail(res, e.message, 500); }
});

// Open pool of pending, unclaimed requests — a driver browses these after an empty run.
ride360Router.get('/requests/pool', ride360Auth, requireDriver, async (_req, res) => {
  try {
    const rows = await query<any>(`SELECT * FROM ride360_requests WHERE status='pending' AND claimed_by_driver_id IS NULL ORDER BY created_at DESC LIMIT 100`, []);
    ok(res, rows.map(mapRequest));
  } catch (e: any) { fail(res, e.message, 500); }
});

// Drivers currently running an empty leg, for a customer to browse & reach out to directly.
ride360Router.get('/nearby-drivers', ride360Auth, requireCustomer, async (_req, res) => {
  try {
    const rows = await query<any>(
      `SELECT r.*, d.name AS driver_name, d.vehicle_type, d.vehicle_number
       FROM ride360_rides r JOIN ride360_drivers d ON d.id = r.driver_id
       WHERE r.kind='empty' AND r.status='active' ORDER BY r.live_updated_at DESC NULLS LAST LIMIT 100`,
      []
    );
    ok(res, rows.map((row: any) => ({
      ride: mapRide(row),
      driver: { id: row.driver_id, name: row.driver_name, vehicleType: row.vehicle_type, vehicleNumber: row.vehicle_number },
    })));
  } catch (e: any) { fail(res, e.message, 500); }
});

ride360Router.post('/requests', ride360Auth, requireCustomer, async (req: R360Req, res) => {
  try {
    const { type, pickup, drop, description, offeredAmount, targetDriverId, originEmptyRideId } = req.body;
    if (!pickup || !drop || !offeredAmount) { fail(res, 'pickup, drop and offeredAmount are required'); return; }
    const customer = await queryOne<any>('SELECT * FROM ride360_customers WHERE id=$1', [req.ride360User!.sub]);
    const messages = targetDriverId
      ? [{ from: 'customer', text: `${customer.phone} reached out to your empty run directly — looking for a ${type === 'parcel' ? 'courier drop' : 'ride'}.`, at: new Date().toISOString() }]
      : [];
    const [row] = await query<any>(
      `INSERT INTO ride360_requests
         (customer_id, customer_phone, type, pickup, drop_point, description, offered_amount, current_amount, claimed_by_driver_id, origin_empty_ride_id, contact_initiated_by, messages)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11) RETURNING *`,
      [
        req.ride360User!.sub, customer.phone, type || 'ride', JSON.stringify(pickup), JSON.stringify(drop), description || '', offeredAmount,
        targetDriverId || null, originEmptyRideId || null, targetDriverId ? 'customer' : null, JSON.stringify(messages),
      ]
    );
    if (targetDriverId) {
      await pushNotif('driver', targetDriverId, 'outreach', `📩 A nearby customer reached out — ${description || ''} · ₹${offeredAmount}`, row.id);
    }
    ok(res, mapRequest(row), 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

ride360Router.post('/requests/:id/reach-out', ride360Auth, requireDriver, async (req: R360Req, res) => {
  try {
    const { originEmptyRideId } = req.body;
    const driver = await queryOne<any>('SELECT * FROM ride360_drivers WHERE id=$1', [req.ride360User!.sub]);
    const existing = await queryOne<any>('SELECT * FROM ride360_requests WHERE id=$1', [req.params.id]);
    if (!existing) { fail(res, 'Request not found', 404); return; }
    const messages = [...(existing.messages || []), { from: 'driver', text: `${driver.name} (${driver.vehicle_number || driver.vehicle_type}) can pick this up. Reaching out now.`, at: new Date().toISOString() }];
    const [row] = await query<any>(
      `UPDATE ride360_requests SET claimed_by_driver_id=$1, origin_empty_ride_id=$2, contact_initiated_by='driver', messages=$3 WHERE id=$4 RETURNING *`,
      [req.ride360User!.sub, originEmptyRideId || null, JSON.stringify(messages), req.params.id]
    );
    await pushNotif('customer', row.customer_id, 'outreach', `🚕 ${driver.name} reached out about your ${row.type} request — ₹${row.current_amount}`, row.id);
    ok(res, mapRequest(row));
  } catch (e: any) { fail(res, e.message, 500); }
});

ride360Router.patch('/requests/:id/status', ride360Auth, async (req: R360Req, res) => {
  try {
    const { status } = req.body as { status: 'confirmed' | 'rejected' };
    if (!['confirmed', 'rejected'].includes(status)) { fail(res, 'status must be confirmed or rejected'); return; }
    const [row] = await query<any>('UPDATE ride360_requests SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
    if (!row) { fail(res, 'Request not found', 404); return; }
    const text = status === 'confirmed' ? `✅ Request confirmed at ₹${row.current_amount}` : `❌ Request was rejected.`;
    if (row.contact_initiated_by === 'driver' && row.claimed_by_driver_id) await pushNotif('driver', row.claimed_by_driver_id, 'status', text, row.id);
    if (row.contact_initiated_by === 'customer') await pushNotif('customer', row.customer_id, 'status', text, row.id);
    ok(res, mapRequest(row));
  } catch (e: any) { fail(res, e.message, 500); }
});

ride360Router.post('/requests/:id/messages', ride360Auth, async (req: R360Req, res) => {
  try {
    const { text, amount } = req.body as { text: string; amount?: number };
    if (!text?.trim() && amount == null) { fail(res, 'text or amount is required'); return; }
    const from = req.ride360User!.role;
    const existing = await queryOne<any>('SELECT * FROM ride360_requests WHERE id=$1', [req.params.id]);
    if (!existing) { fail(res, 'Request not found', 404); return; }
    const msg: any = { from, text: text?.trim() || `Proposed a new price: ₹${amount}`, at: new Date().toISOString() };
    if (amount != null) msg.amount = amount;
    const messages = [...(existing.messages || []), msg];
    const sets = amount != null ? `messages=$1, current_amount=$2` : `messages=$1`;
    const params = amount != null ? [JSON.stringify(messages), amount, req.params.id] : [JSON.stringify(messages), req.params.id];
    const idIdx = amount != null ? 3 : 2;
    const [row] = await query<any>(`UPDATE ride360_requests SET ${sets} WHERE id=$${idIdx} RETURNING *`, params);

    const label = amount != null ? `💰 New price proposed: ₹${amount}` : `💬 ${text.slice(0, 60)}`;
    if (from === 'driver' && row.customer_id) await pushNotif('customer', row.customer_id, 'message', label, row.id);
    else if (from === 'customer' && row.claimed_by_driver_id) await pushNotif('driver', row.claimed_by_driver_id, 'message', label, row.id);
    ok(res, mapRequest(row));
  } catch (e: any) { fail(res, e.message, 500); }
});

// ── NOTIFICATIONS ─────────────────────────────────────────────
ride360Router.get('/notifications', ride360Auth, async (req: R360Req, res) => {
  try {
    const rows = await query<any>(
      'SELECT * FROM ride360_notifications WHERE for_type=$1 AND for_id=$2 ORDER BY created_at DESC LIMIT 50',
      [req.ride360User!.role, req.ride360User!.sub]
    );
    ok(res, rows.map(mapNotification));
  } catch (e: any) { fail(res, e.message, 500); }
});
ride360Router.patch('/notifications/read-all', ride360Auth, async (req: R360Req, res) => {
  try {
    await query('UPDATE ride360_notifications SET read=TRUE WHERE for_type=$1 AND for_id=$2', [req.ride360User!.role, req.ride360User!.sub]);
    ok(res, { updated: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ── AI USAGE (feature-invocation counters — no real LLM is called here) ──
ride360Router.post('/ai-usage', ride360Auth, async (req: R360Req, res) => {
  try {
    const { feature } = req.body as { feature: string };
    if (!feature) { fail(res, 'feature is required'); return; }
    await query('INSERT INTO ride360_ai_usage (user_type, user_id, feature) VALUES ($1,$2,$3)', [req.ride360User!.role, req.ride360User!.sub, feature]);
    ok(res, { logged: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

export default ride360Router;
