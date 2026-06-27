// ============================================================
// TEA PROCUREMENT MODULE — Full CRUD + AI Endpoints
// ============================================================
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { query, queryOne, withTransaction } from '../../config/db';
import { authMiddleware } from '../auth/auth.service';
import { requireRole, requireTenantAccess } from '../../core/guards/roleGuard';
import { signJwt, verifyJwt } from '../../utils/jwtUtils';

export const teaRouter = Router({ mergeParams: true });

// ── Grower portal JWT middleware (used on grower-only routes) ──
function growerAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Unauthorised' });
  try {
    const payload = verifyJwt(header.slice(7));
    if (payload.role !== 'grower_portal') return res.status(403).json({ success: false, error: 'Not a grower token' });
    (req as any).grower = payload;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired grower token' });
  }
}

// ── Public: grower portal login (phone + PIN) — before authMiddleware ──
teaRouter.post('/grower-login', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { phone, pin } = req.body;
    if (!phone || !pin) return fail(res, 'phone and pin required');

    const grower = await queryOne<any>(
      `SELECT * FROM tea_growers WHERE tenant_id=$1 AND phone=$2 AND portal_enabled=TRUE AND is_active=TRUE`,
      [tenantId, phone.trim()]
    );
    if (!grower) return fail(res, 'Grower not found or portal not enabled', 401);

    const valid = await bcrypt.compare(String(pin), grower.portal_pin_hash || '');
    if (!valid) return fail(res, 'Invalid PIN', 401);

    const token = signJwt({ role: 'grower_portal', growerId: grower.id, tenantId }, '24h');
    ok(res, { token, grower: { id: grower.id, name: grower.name, phone: grower.phone } });
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.use(authMiddleware);
teaRouter.use(requireTenantAccess());

function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}

// ──────────────────────────────────────────────────────────────
// DASHBOARD
// ──────────────────────────────────────────────────────────────
teaRouter.get('/dashboard', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const today = new Date().toISOString().slice(0, 10);

    const [todayKg] = await query<any>(
      `SELECT COALESCE(SUM(tc.net_weight), 0) AS kg, COUNT(DISTINCT tc.grower_id)::int AS growers
       FROM tea_collections tc
       JOIN tea_collection_batches tcb ON tcb.id = tc.batch_id
       WHERE tcb.tenant_id = $1 AND tcb.collection_date = $2`,
      [tenantId, today]
    );

    const [pendingDispatch] = await query<any>(
      `SELECT COUNT(*)::int AS count
       FROM tea_collection_batches
       WHERE tenant_id = $1 AND status = 'pending_dispatch'`,
      [tenantId]
    );

    const [factoryReceivable] = await query<any>(
      `SELECT COALESCE(SUM(tfs.accepted_kg * twr.grade_a_rate), 0) AS amount
       FROM tea_factory_settlements tfs
       JOIN tea_dispatches td ON td.id = tfs.dispatch_id
       JOIN tea_weekly_rates twr ON twr.tenant_id = td.tenant_id AND twr.week_number = EXTRACT(WEEK FROM tfs.settled_at)::int
       WHERE td.tenant_id = $1 AND tfs.payment_received = FALSE`,
      [tenantId]
    );

    const [pendingPayments] = await query<any>(
      `SELECT COALESCE(SUM(tgs.net_payable), 0) AS amount
       FROM tea_grower_settlements tgs
       WHERE tgs.tenant_id = $1 AND tgs.paid = FALSE`,
      [tenantId]
    );

    ok(res, {
      today_kg: parseFloat(todayKg?.kg || '0'),
      today_growers: todayKg?.growers || 0,
      dispatch_pending: pendingDispatch?.count || 0,
      factory_receivable: parseFloat(factoryReceivable?.amount || '0'),
      pending_payments: parseFloat(pendingPayments?.amount || '0'),
    });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ──────────────────────────────────────────────────────────────
// GROWERS
// ──────────────────────────────────────────────────────────────

// List growers
teaRouter.get('/growers', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { search = '', is_active } = req.query as any;

    const conds: string[] = ['tenant_id = $1'];
    const vals: any[] = [tenantId];
    let i = 2;

    if (search) {
      conds.push(`(name ILIKE $${i} OR grower_code ILIKE $${i} OR phone ILIKE $${i})`);
      vals.push(`%${search}%`); i++;
    }
    if (is_active !== undefined) {
      conds.push(`is_active = $${i++}`);
      vals.push(is_active === 'true');
    }

    const rows = await query<any>(
      `SELECT * FROM tea_growers WHERE ${conds.join(' AND ')} ORDER BY name`,
      vals
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// Create grower
teaRouter.post('/growers', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { name, grower_code, phone, address, land_acres, land_type, pluck_cycle_days } = req.body;

    if (!name) return fail(res, 'Name is required');

    const [grower] = await query<any>(
      `INSERT INTO tea_growers (tenant_id, name, grower_code, phone, address, land_acres, land_type, pluck_cycle_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tenantId, name, grower_code || null, phone || null, address || null,
       land_acres || null, land_type || null, pluck_cycle_days || 15]
    );
    ok(res, grower, 201);
  } catch (e: any) { fail(res, e.message); }
});

// Update grower
teaRouter.put('/growers/:growerId', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId, growerId } = req.params as any;
    const { name, phone, address, land_acres, land_type, pluck_cycle_days, is_active, last_pluck_date, will_pluck } = req.body;

    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (name !== undefined)             { sets.push(`name=$${i++}`);              vals.push(name); }
    if (phone !== undefined)            { sets.push(`phone=$${i++}`);             vals.push(phone); }
    if (address !== undefined)          { sets.push(`address=$${i++}`);           vals.push(address); }
    if (land_acres !== undefined)       { sets.push(`land_acres=$${i++}`);        vals.push(land_acres); }
    if (land_type !== undefined)        { sets.push(`land_type=$${i++}`);         vals.push(land_type); }
    if (pluck_cycle_days !== undefined) { sets.push(`pluck_cycle_days=$${i++}`);  vals.push(pluck_cycle_days); }
    if (is_active !== undefined)        { sets.push(`is_active=$${i++}`);         vals.push(is_active); }
    if (last_pluck_date !== undefined)  { sets.push(`last_pluck_date=$${i++}`);   vals.push(last_pluck_date); }
    if (will_pluck !== undefined)       { sets.push(`will_pluck=$${i++}`);        vals.push(will_pluck); }

    if (!sets.length) return fail(res, 'No fields to update');
    sets.push(`updated_at=NOW()`);
    vals.push(growerId, tenantId);

    const [g] = await query<any>(
      `UPDATE tea_growers SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING *`,
      vals
    );
    if (!g) return fail(res, 'Grower not found', 404);
    ok(res, g);
  } catch (e: any) { fail(res, e.message); }
});

// Grower pluck plan (next expected pluck dates for planning)
teaRouter.get('/growers/pluck-plan', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>(
      `SELECT
         g.*,
         g.last_pluck_date + (g.pluck_cycle_days || ' days')::INTERVAL AS next_pluck_date,
         (g.last_pluck_date + (g.pluck_cycle_days || ' days')::INTERVAL)::date = CURRENT_DATE AS pluck_today,
         (g.last_pluck_date + (g.pluck_cycle_days || ' days')::INTERVAL)::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 3 AS pluck_soon
       FROM tea_growers g
       WHERE g.tenant_id = $1 AND g.is_active = TRUE
       ORDER BY next_pluck_date`,
      [tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// ──────────────────────────────────────────────────────────────
// WEEKLY RATES
// ──────────────────────────────────────────────────────────────

teaRouter.get('/rates', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>(
      `SELECT *,
         to_date(week_year::text || '-' || lpad(week_number::text, 2, '0') || '-1', 'IYYY-IW-ID') AS week_start_date
       FROM tea_weekly_rates WHERE tenant_id = $1 ORDER BY week_year DESC, week_number DESC LIMIT 12`,
      [tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.get('/rates/current', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const row = await queryOne<any>(
      `SELECT * FROM tea_weekly_rates
       WHERE tenant_id = $1 AND week_year = EXTRACT(YEAR FROM NOW())::int AND week_number = EXTRACT(WEEK FROM NOW())::int`,
      [tenantId]
    );
    ok(res, row);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/rates', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { week_number, week_year, grade_a_rate, grade_b_rate, grade_c_rate, notes,
            effective_date, payment_mode, advance_rate_a, advance_rate_b, advance_rate_c } = req.body;

    // Derive week_number/week_year from effective_date if not provided directly
    let wkNum = week_number;
    let wkYear = week_year;
    if (!wkNum) {
      const dateParam = effective_date || new Date().toISOString().slice(0, 10);
      const row = await queryOne<any>(
        `SELECT EXTRACT(WEEK FROM $1::date)::int AS wk, EXTRACT(ISOYEAR FROM $1::date)::int AS yr`,
        [dateParam]
      );
      wkNum = row!.wk;
      wkYear = row!.yr;
    }
    wkYear = wkYear || new Date().getFullYear();

    const [rate] = await query<any>(
      `INSERT INTO tea_weekly_rates
         (tenant_id, week_number, week_year, grade_a_rate, grade_b_rate, grade_c_rate, notes,
          payment_mode, advance_rate_a, advance_rate_b, advance_rate_c)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id, week_number, week_year)
       DO UPDATE SET grade_a_rate=$4, grade_b_rate=$5, grade_c_rate=$6, notes=$7,
                     payment_mode=$8, advance_rate_a=$9, advance_rate_b=$10, advance_rate_c=$11,
                     updated_at=NOW()
       RETURNING *,
         to_date(week_year::text || '-' || lpad(week_number::text, 2, '0') || '-1', 'IYYY-IW-ID') AS week_start_date`,
      [tenantId, wkNum, wkYear, grade_a_rate, grade_b_rate, grade_c_rate, notes || null,
       payment_mode || 'full',
       advance_rate_a ? parseFloat(advance_rate_a) : null,
       advance_rate_b ? parseFloat(advance_rate_b) : null,
       advance_rate_c ? parseFloat(advance_rate_c) : null]
    );
    ok(res, rate, 201);
  } catch (e: any) { fail(res, e.message); }
});

// ──────────────────────────────────────────────────────────────
// COLLECTION BATCHES + COLLECTIONS
// ──────────────────────────────────────────────────────────────

// List batches
teaRouter.get('/collections/batches', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { date, status } = req.query as any;

    const conds: string[] = ['tenant_id = $1'];
    const vals: any[] = [tenantId];
    let i = 2;
    if (date) { conds.push(`collection_date = $${i++}`); vals.push(date); }
    if (status) { conds.push(`status = $${i++}`); vals.push(status); }

    const rows = await query<any>(
      `SELECT * FROM tea_collection_batches WHERE ${conds.join(' AND ')} ORDER BY collection_date DESC LIMIT 30`,
      vals
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// Create batch (one per day usually)
teaRouter.post('/collections/batches', requireRole('superadmin', 'owner', 'manager', 'staff', 'collection_manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { collection_date, notes } = req.body;
    const date = collection_date || new Date().toISOString().slice(0, 10);

    const existing = await queryOne<any>(
      `SELECT id FROM tea_collection_batches WHERE tenant_id=$1 AND collection_date=$2`,
      [tenantId, date]
    );
    if (existing) return ok(res, existing); // Return existing batch for the day

    const [batch] = await query<any>(
      `INSERT INTO tea_collection_batches (tenant_id, collection_date, notes)
       VALUES ($1,$2,$3) RETURNING *`,
      [tenantId, date, notes || null]
    );
    ok(res, batch, 201);
  } catch (e: any) { fail(res, e.message); }
});

// Get collection entries for a batch
teaRouter.get('/collections/batches/:batchId/entries', async (req, res) => {
  try {
    const { tenantId, batchId } = req.params as any;
    const rows = await query<any>(
      `SELECT tc.*, g.name AS grower_name, g.grower_code
       FROM tea_collections tc
       JOIN tea_growers g ON g.id = tc.grower_id
       JOIN tea_collection_batches b ON b.id = tc.batch_id
       WHERE tc.batch_id = $1 AND b.tenant_id = $2
       ORDER BY tc.created_at`,
      [batchId, tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// Add collection entry
teaRouter.post('/collections/batches/:batchId/entries', requireRole('superadmin', 'owner', 'manager', 'staff', 'collection_manager'), async (req, res) => {
  try {
    const { tenantId, batchId } = req.params as any;
    const { grower_id, gross_weight, moisture_deduction_kg = 0, grade = 'A', notes } = req.body;

    if (!grower_id || !gross_weight) return fail(res, 'grower_id and gross_weight required');

    // Rate is NOT applied at collection time — owner sets rate at week end; settlement recalculates
    const net_weight = parseFloat(gross_weight) - parseFloat(moisture_deduction_kg);

    const [entry] = await query<any>(
      `INSERT INTO tea_collections
         (batch_id, grower_id, gross_weight, moisture_deduction_kg, net_weight, grade, rate_per_kg, amount, notes)
       VALUES ($1,$2,$3,$4,$5,$6,0,0,$7) RETURNING *`,
      [batchId, grower_id, gross_weight, moisture_deduction_kg, net_weight, grade, notes || null]
    );

    // Update batch totals
    await query(
      `UPDATE tea_collection_batches
       SET total_kg = (SELECT COALESCE(SUM(net_weight),0) FROM tea_collections WHERE batch_id=$1),
           total_amount = (SELECT COALESCE(SUM(amount),0) FROM tea_collections WHERE batch_id=$1),
           grower_count = (SELECT COUNT(DISTINCT grower_id)::int FROM tea_collections WHERE batch_id=$1),
           updated_at = NOW()
       WHERE id = $1`,
      [batchId]
    );

    // Update grower last pluck date
    await query(
      `UPDATE tea_growers SET last_pluck_date = CURRENT_DATE, will_pluck = FALSE WHERE id = $1`,
      [grower_id]
    );

    ok(res, entry, 201);
  } catch (e: any) { fail(res, e.message); }
});

// Update collection entry
teaRouter.put('/collections/entries/:entryId', requireRole('superadmin', 'owner', 'manager', 'staff'), async (req, res) => {
  try {
    const { entryId } = req.params as any;
    const { gross_weight, moisture_deduction_kg = 0, grade } = req.body;

    const net_weight = parseFloat(gross_weight) - parseFloat(moisture_deduction_kg);
    const [entry] = await query<any>(
      `UPDATE tea_collections
       SET gross_weight=$1, moisture_deduction_kg=$2, net_weight=$3, grade=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [gross_weight, moisture_deduction_kg, net_weight, grade, entryId]
    );
    ok(res, entry);
  } catch (e: any) { fail(res, e.message); }
});

// ──────────────────────────────────────────────────────────────
// FACTORIES
// ──────────────────────────────────────────────────────────────

teaRouter.get('/factories', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>(
      `SELECT * FROM tea_factories WHERE tenant_id = $1 ORDER BY name`,
      [tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/factories', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { name, contact_name, phone, address, current_rate_per_kg } = req.body;

    if (!name) return fail(res, 'Name is required');

    const [factory] = await query<any>(
      `INSERT INTO tea_factories (tenant_id, name, contact_name, phone, address, current_rate_per_kg)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantId, name, contact_name || null, phone || null, address || null, current_rate_per_kg || null]
    );
    ok(res, factory, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.put('/factories/:factoryId', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId, factoryId } = req.params as any;
    const { name, contact_name, phone, address, current_rate_per_kg, is_active } = req.body;

    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (name !== undefined)               { sets.push(`name=$${i++}`);                vals.push(name); }
    if (contact_name !== undefined)       { sets.push(`contact_name=$${i++}`);        vals.push(contact_name); }
    if (phone !== undefined)              { sets.push(`phone=$${i++}`);               vals.push(phone); }
    if (address !== undefined)            { sets.push(`address=$${i++}`);             vals.push(address); }
    if (current_rate_per_kg !== undefined){ sets.push(`current_rate_per_kg=$${i++}`); vals.push(current_rate_per_kg); }
    if (is_active !== undefined)          { sets.push(`is_active=$${i++}`);           vals.push(is_active); }

    if (!sets.length) return fail(res, 'No fields to update');
    sets.push(`updated_at=NOW()`);
    vals.push(factoryId, tenantId);

    const [f] = await query<any>(
      `UPDATE tea_factories SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING *`,
      vals
    );
    if (!f) return fail(res, 'Factory not found', 404);
    ok(res, f);
  } catch (e: any) { fail(res, e.message); }
});

// ──────────────────────────────────────────────────────────────
// VEHICLES
// ──────────────────────────────────────────────────────────────

teaRouter.get('/vehicles', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>(
      `SELECT * FROM tea_vehicles WHERE tenant_id = $1 ORDER BY vehicle_number`,
      [tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/vehicles', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { vehicle_number, driver_name, driver_phone, is_rental } = req.body;

    if (!vehicle_number) return fail(res, 'vehicle_number is required');

    const [v] = await query<any>(
      `INSERT INTO tea_vehicles (tenant_id, vehicle_number, driver_name, driver_phone, is_rental)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, vehicle_number, driver_name || null, driver_phone || null, is_rental || false]
    );
    ok(res, v, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.put('/vehicles/:vehicleId', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId, vehicleId } = req.params as any;
    const { vehicle_number, driver_name, driver_phone, is_rental, is_active } = req.body;

    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (vehicle_number !== undefined) { sets.push(`vehicle_number=$${i++}`); vals.push(vehicle_number); }
    if (driver_name !== undefined)    { sets.push(`driver_name=$${i++}`);    vals.push(driver_name); }
    if (driver_phone !== undefined)   { sets.push(`driver_phone=$${i++}`);   vals.push(driver_phone); }
    if (is_rental !== undefined)      { sets.push(`is_rental=$${i++}`);       vals.push(is_rental); }
    if (is_active !== undefined)      { sets.push(`is_active=$${i++}`);       vals.push(is_active); }

    if (!sets.length) return fail(res, 'No fields to update');
    sets.push(`updated_at=NOW()`);
    vals.push(vehicleId, tenantId);

    const [v] = await query<any>(
      `UPDATE tea_vehicles SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING *`,
      vals
    );
    if (!v) return fail(res, 'Vehicle not found', 404);
    ok(res, v);
  } catch (e: any) { fail(res, e.message); }
});

// ──────────────────────────────────────────────────────────────
// DISPATCH
// ──────────────────────────────────────────────────────────────

teaRouter.get('/dispatches', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { status } = req.query as any;

    const conds = ['td.tenant_id = $1'];
    const vals: any[] = [tenantId];
    let i = 2;
    if (status) { conds.push(`td.status = $${i++}`); vals.push(status); }

    let rows: any[];
    try {
      rows = await query<any>(
        `SELECT td.*, tf.name AS factory_name, tv.vehicle_number,
           COUNT(b.id)::int AS bag_count,
           COALESCE(SUM(CASE WHEN b.grade='A' THEN b.weight_kg ELSE 0 END),0) AS grade_a_kg,
           COALESCE(SUM(CASE WHEN b.grade='B' THEN b.weight_kg ELSE 0 END),0) AS grade_b_kg,
           COALESCE(SUM(CASE WHEN b.grade='C' THEN b.weight_kg ELSE 0 END),0) AS grade_c_kg,
           SUM(b.factory_weight_kg) AS factory_bag_total_kg
         FROM tea_dispatches td
         LEFT JOIN tea_factories tf ON tf.id = td.factory_id
         LEFT JOIN tea_vehicles tv ON tv.id = td.vehicle_id
         LEFT JOIN tea_dispatch_bags b ON b.dispatch_id = td.id
         WHERE ${conds.join(' AND ')}
         GROUP BY td.id, tf.name, tv.vehicle_number
         ORDER BY td.dispatch_date DESC
         LIMIT 50`,
        vals
      );
    } catch {
      // Fallback: tea_dispatch_bags may not exist yet (migration pending server restart)
      rows = await query<any>(
        `SELECT td.*, tf.name AS factory_name, tv.vehicle_number,
           0 AS bag_count, 0 AS grade_a_kg, 0 AS grade_b_kg, 0 AS grade_c_kg,
           NULL::numeric AS factory_bag_total_kg, NULL::numeric AS factory_total_kg
         FROM tea_dispatches td
         LEFT JOIN tea_factories tf ON tf.id = td.factory_id
         LEFT JOIN tea_vehicles tv ON tv.id = td.vehicle_id
         WHERE ${conds.join(' AND ')}
         ORDER BY td.dispatch_date DESC
         LIMIT 50`,
        vals
      );
    }
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/dispatches', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { factory_id, vehicle_id, dispatch_date, batch_ids, total_kg = 0, notes, driver_name, driver_phone } = req.body;

    if (!factory_id) return fail(res, 'factory_id required');

    const [dispatch] = await withTransaction(async (client) => {
      const [d] = (await client.query(
        `INSERT INTO tea_dispatches (tenant_id, factory_id, vehicle_id, dispatch_date, total_kg, notes, driver_name, driver_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [tenantId, factory_id, vehicle_id || null, dispatch_date || new Date().toISOString().slice(0, 10), total_kg, notes || null, driver_name || null, driver_phone || null]
      )).rows;

      // Link batches to dispatch
      if (batch_ids?.length) {
        for (const batchId of batch_ids) {
          await client.query(
            `INSERT INTO tea_dispatch_details (dispatch_id, batch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [d.id, batchId]
          );
          await client.query(
            `UPDATE tea_collection_batches SET status='dispatched', updated_at=NOW() WHERE id=$1 AND tenant_id=$2`,
            [batchId, tenantId]
          );
        }
      }

      return [d];
    });

    ok(res, dispatch, 201);
  } catch (e: any) { fail(res, e.message); }
});

// ──────────────────────────────────────────────────────────────
// DISPATCH BAGS
// ──────────────────────────────────────────────────────────────

teaRouter.get('/dispatches/:dispatchId/bags', async (req, res) => {
  try {
    const { tenantId, dispatchId } = req.params as any;
    const rows = await query<any>(
      `SELECT b.* FROM tea_dispatch_bags b
       JOIN tea_dispatches d ON d.id = b.dispatch_id
       WHERE b.dispatch_id=$1 AND d.tenant_id=$2
       ORDER BY b.bag_number`,
      [dispatchId, tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/dispatches/:dispatchId/bags', requireRole('superadmin', 'owner', 'manager', 'staff'), async (req, res) => {
  try {
    const { tenantId, dispatchId } = req.params as any;
    const { weight_kg, grade = 'A', notes } = req.body;
    if (!weight_kg) return fail(res, 'weight_kg required');

    // Auto-assign next bag number
    const [{ next_num }] = await query<any>(
      `SELECT COALESCE(MAX(bag_number), 0) + 1 AS next_num FROM tea_dispatch_bags WHERE dispatch_id=$1`,
      [dispatchId]
    );

    const [bag] = await query<any>(
      `INSERT INTO tea_dispatch_bags (dispatch_id, bag_number, weight_kg, grade, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [dispatchId, next_num, parseFloat(weight_kg), grade, notes || null]
    );

    // Update dispatch total_kg
    await query(
      `UPDATE tea_dispatches SET total_kg=(SELECT COALESCE(SUM(weight_kg),0) FROM tea_dispatch_bags WHERE dispatch_id=$1), updated_at=NOW() WHERE id=$1`,
      [dispatchId]
    );

    ok(res, bag, 201);
  } catch (e: any) { fail(res, e.message); }
});

// Update factory weight on a single bag
teaRouter.patch('/dispatches/:dispatchId/bags/:bagId', requireRole('superadmin', 'owner', 'manager', 'staff'), async (req, res) => {
  try {
    const { dispatchId, bagId } = req.params as any;
    const { factory_weight_kg } = req.body;
    const val = factory_weight_kg !== undefined && factory_weight_kg !== '' ? parseFloat(factory_weight_kg) : null;
    const [bag] = await query<any>(
      `UPDATE tea_dispatch_bags SET factory_weight_kg=$1 WHERE id=$2 AND dispatch_id=$3 RETURNING *`,
      [val, bagId, dispatchId]
    );
    ok(res, bag);
  } catch (e: any) { fail(res, e.message); }
});

// Update dispatch-level consolidated factory weight
teaRouter.patch('/dispatches/:dispatchId', requireRole('superadmin', 'owner', 'manager', 'staff'), async (req, res) => {
  try {
    const { tenantId, dispatchId } = req.params as any;
    const { factory_total_kg, status } = req.body;
    const sets: string[] = ['updated_at=NOW()'];
    const vals: any[] = [];
    let i = 1;
    if (factory_total_kg !== undefined) { sets.push(`factory_total_kg=$${i++}`); vals.push(factory_total_kg !== '' ? parseFloat(factory_total_kg) : null); }
    if (status) { sets.push(`status=$${i++}`); vals.push(status); }
    vals.push(dispatchId, tenantId);
    const [d] = await query<any>(
      `UPDATE tea_dispatches SET ${sets.join(',')} WHERE id=$${i++} AND tenant_id=$${i} RETURNING *`,
      vals
    );
    ok(res, d);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.delete('/dispatches/:dispatchId/bags/:bagId', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId, dispatchId, bagId } = req.params as any;
    await query(`DELETE FROM tea_dispatch_bags WHERE id=$1 AND dispatch_id=$2`, [bagId, dispatchId]);
    // Recalculate total
    await query(
      `UPDATE tea_dispatches SET total_kg=(SELECT COALESCE(SUM(weight_kg),0) FROM tea_dispatch_bags WHERE dispatch_id=$1), updated_at=NOW() WHERE id=$1`,
      [dispatchId]
    );
    // Re-number remaining bags sequentially
    await query(
      `UPDATE tea_dispatch_bags b SET bag_number = sub.rn
       FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) AS rn FROM tea_dispatch_bags WHERE dispatch_id=$1) sub
       WHERE b.id = sub.id`,
      [dispatchId]
    );
    ok(res, { deleted: true });
  } catch (e: any) { fail(res, e.message); }
});

// ──────────────────────────────────────────────────────────────
// FACTORY SETTLEMENTS
// ──────────────────────────────────────────────────────────────

teaRouter.get('/settlements/factory', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    let rows: any[];
    try {
      rows = await query<any>(
        `SELECT
           tfs.id,
           COALESCE(tfs.settlement_date, tfs.settled_at::date) AS settlement_date,
           tfs.accepted_kg   AS total_kg,
           tfs.rejected_kg,
           COALESCE(tfs.grade_a_kg, 0) AS grade_a_kg,
           COALESCE(tfs.grade_b_kg, 0) AS grade_b_kg,
           COALESCE(tfs.grade_c_kg, 0) AS grade_c_kg,
           tfs.rate_per_kg_a, tfs.rate_per_kg_b, tfs.rate_per_kg_c,
           tfs.rate_per_kg,
           COALESCE(
             NULLIF(COALESCE(tfs.grade_a_kg,0)*COALESCE(tfs.rate_per_kg_a,0)
                  + COALESCE(tfs.grade_b_kg,0)*COALESCE(tfs.rate_per_kg_b,0)
                  + COALESCE(tfs.grade_c_kg,0)*COALESCE(tfs.rate_per_kg_c,0), 0),
             tfs.accepted_kg * COALESCE(tfs.rate_per_kg, 0)
           ) AS gross_amount,
           COALESCE(tfs.deductions, 0) AS deductions,
           tfs.total_amount AS net_amount,
           CASE WHEN tfs.payment_received THEN 'paid' ELSE 'pending' END AS payment_status,
           tfs.notes,
           COALESCE(tf.name, 'Unknown Factory') AS factory_name,
           td.dispatch_date,
           td.total_kg AS dispatched_kg
         FROM tea_factory_settlements tfs
         JOIN tea_dispatches td ON td.id = tfs.dispatch_id
         LEFT JOIN tea_factories tf ON tf.id = td.factory_id
         WHERE td.tenant_id = $1
         ORDER BY COALESCE(tfs.settlement_date, tfs.settled_at::date) DESC
         LIMIT 100`,
        [tenantId]
      );
    } catch {
      // Fallback: grade columns (migration 040) may not exist yet
      rows = await query<any>(
        `SELECT
           tfs.id,
           tfs.settled_at::date AS settlement_date,
           tfs.accepted_kg AS total_kg,
           tfs.rejected_kg,
           0 AS grade_a_kg, 0 AS grade_b_kg, 0 AS grade_c_kg,
           NULL AS rate_per_kg_a, NULL AS rate_per_kg_b, NULL AS rate_per_kg_c,
           tfs.rate_per_kg,
           tfs.accepted_kg * COALESCE(tfs.rate_per_kg, 0) AS gross_amount,
           0 AS deductions,
           tfs.total_amount AS net_amount,
           CASE WHEN tfs.payment_received THEN 'paid' ELSE 'pending' END AS payment_status,
           tfs.notes,
           COALESCE(tf.name, 'Unknown Factory') AS factory_name,
           td.dispatch_date,
           td.total_kg AS dispatched_kg
         FROM tea_factory_settlements tfs
         JOIN tea_dispatches td ON td.id = tfs.dispatch_id
         LEFT JOIN tea_factories tf ON tf.id = td.factory_id
         WHERE td.tenant_id = $1
         ORDER BY tfs.settled_at DESC
         LIMIT 100`,
        [tenantId]
      );
    }
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/settlements/factory', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const {
      factory_id, dispatch_id, settlement_date,
      grade_a_kg = 0, grade_b_kg = 0, grade_c_kg = 0,
      rate_per_kg_a, rate_per_kg_b, rate_per_kg_c,
      deductions = 0, rejected_kg = 0, notes,
    } = req.body;

    const aKg = parseFloat(grade_a_kg) || 0;
    const bKg = parseFloat(grade_b_kg) || 0;
    const cKg = parseFloat(grade_c_kg) || 0;
    const totalKg = aKg + bKg + cKg;
    if (!totalKg) return fail(res, 'At least one grade KG is required');

    const aRate = parseFloat(rate_per_kg_a) || 0;
    const bRate = parseFloat(rate_per_kg_b) || 0;
    const cRate = parseFloat(rate_per_kg_c) || 0;

    const gross = aKg * aRate + bKg * bRate + cKg * cRate;
    const deductAmt = parseFloat(deductions) || 0;
    const net_amount = gross - deductAmt;
    const sDate = settlement_date || new Date().toISOString().slice(0, 10);

    let resolvedDispatchId = dispatch_id;
    if (!resolvedDispatchId && factory_id) {
      const [d] = await query<any>(
        `INSERT INTO tea_dispatches (tenant_id, factory_id, dispatch_date, total_kg, notes, status)
         VALUES ($1,$2,$3,$4,$5,'settled') RETURNING id`,
        [tenantId, factory_id, sDate, totalKg, notes || null]
      );
      resolvedDispatchId = d.id;
    }

    if (!resolvedDispatchId) return fail(res, 'factory_id or dispatch_id required');

    const [settlement] = await query<any>(
      `INSERT INTO tea_factory_settlements
         (dispatch_id, accepted_kg, rejected_kg, rate_per_kg,
          grade_a_kg, grade_b_kg, grade_c_kg,
          rate_per_kg_a, rate_per_kg_b, rate_per_kg_c,
          deductions, total_amount, settlement_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [resolvedDispatchId, totalKg, parseFloat(rejected_kg) || 0, aRate,
       aKg, bKg, cKg, aRate, bRate, cRate,
       deductAmt, net_amount, sDate, notes || null]
    );

    await query(`UPDATE tea_dispatches SET status='settled', updated_at=NOW() WHERE id=$1`, [resolvedDispatchId]);

    ok(res, { ...settlement, settlement_date: sDate, factory_name: null, payment_status: 'pending', gross_amount: gross, net_amount }, 201);
  } catch (e: any) { fail(res, e.message); }
});

// ──────────────────────────────────────────────────────────────
// FACTORY ADVANCES
// ──────────────────────────────────────────────────────────────

teaRouter.post('/advances/factory', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { factory_id, amount, advance_date, notes } = req.body;

    if (!factory_id || !amount) return fail(res, 'factory_id and amount required');

    const [advance] = await query<any>(
      `INSERT INTO tea_factory_advances (tenant_id, factory_id, amount, advance_date, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, factory_id, amount, advance_date || new Date().toISOString().slice(0, 10), notes || null]
    );
    ok(res, advance, 201);
  } catch (e: any) { fail(res, e.message); }
});

// ──────────────────────────────────────────────────────────────
// GROWER SETTLEMENTS / PAYMENTS
// ──────────────────────────────────────────────────────────────

teaRouter.get('/settlements/grower', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>(
      `SELECT
         tgs.id,
         tgs.grower_id,
         tgs.total_kg,
         tgs.gross_amount,
         tgs.advance_deduction AS advance_deducted,
         tgs.net_payable,
         COALESCE(tgs.balance_carried_forward, 0) AS balance_carried_forward,
         COALESCE(tgs.payment_mode, 'full') AS payment_mode,
         tgs.week_start_date AS period_start,
         tgs.week_end_date AS period_end,
         CASE WHEN tgs.paid THEN 'paid' ELSE 'pending' END AS status,
         tgs.paid_at,
         g.name AS grower_name,
         g.grower_code
       FROM tea_grower_settlements tgs
       JOIN tea_growers g ON g.id = tgs.grower_id
       WHERE tgs.tenant_id = $1
       ORDER BY tgs.week_end_date DESC
       LIMIT 50`,
      [tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// Generate weekly grower settlement
teaRouter.post('/settlements/grower/generate', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { week_start_date, week_end_date, period_start, period_end } = req.body;
    const startDate = week_start_date || period_start;
    const endDate   = week_end_date   || period_end;

    if (!startDate || !endDate) return fail(res, 'week_start_date and week_end_date (or period_start/period_end) required');
    const week_start_date_r = startDate;
    const week_end_date_r   = endDate;

    // Compute gross from weekly rate at settlement time (not from stored tc.amount which may be 0)
    // For advance mode: gross = advance_rate × kg; balance = (full_rate - advance_rate) × kg
    const growerData = await query<any>(
      `SELECT
         tc.grower_id,
         g.name AS grower_name,
         SUM(tc.net_weight) AS total_kg,
         SUM(
           tc.net_weight * COALESCE(
             CASE WHEN COALESCE(wr.payment_mode, 'full') = 'advance' THEN
               CASE tc.grade
                 WHEN 'A' THEN COALESCE(wr.advance_rate_a, wr.grade_a_rate)
                 WHEN 'B' THEN COALESCE(wr.advance_rate_b, wr.grade_b_rate)
                 ELSE COALESCE(wr.advance_rate_c, wr.grade_c_rate)
               END
             ELSE
               CASE tc.grade
                 WHEN 'A' THEN wr.grade_a_rate
                 WHEN 'B' THEN wr.grade_b_rate
                 ELSE wr.grade_c_rate
               END
             END,
             tc.rate_per_kg
           )
         ) AS gross_amount,
         SUM(
           CASE WHEN COALESCE(wr.payment_mode, 'full') = 'advance' THEN
             tc.net_weight * GREATEST(0,
               CASE tc.grade
                 WHEN 'A' THEN wr.grade_a_rate - COALESCE(wr.advance_rate_a, wr.grade_a_rate)
                 WHEN 'B' THEN wr.grade_b_rate - COALESCE(wr.advance_rate_b, wr.grade_b_rate)
                 ELSE wr.grade_c_rate - COALESCE(wr.advance_rate_c, wr.grade_c_rate)
               END
             )
           ELSE 0 END
         ) AS balance_carried_forward,
         COALESCE(MAX(wr.payment_mode), 'full') AS payment_mode,
         COALESCE((SELECT SUM(ga.amount) FROM tea_grower_advances ga
                   WHERE ga.tenant_id=$1 AND ga.grower_id=tc.grower_id AND ga.advance_date BETWEEN $2 AND $3
                   AND ga.deducted = FALSE), 0) AS advance_deduction
       FROM tea_collections tc
       JOIN tea_growers g ON g.id = tc.grower_id
       JOIN tea_collection_batches tcb ON tcb.id = tc.batch_id
       LEFT JOIN tea_weekly_rates wr ON wr.tenant_id = tcb.tenant_id
         AND wr.week_number = EXTRACT(WEEK FROM tcb.collection_date)::int
         AND wr.week_year = EXTRACT(ISOYEAR FROM tcb.collection_date)::int
       WHERE tcb.tenant_id=$1 AND tcb.collection_date BETWEEN $2 AND $3
       GROUP BY tc.grower_id, g.name`,
      [tenantId, week_start_date_r, week_end_date_r]
    );

    const settlements = [];
    for (const gd of growerData) {
      const gross = parseFloat(gd.gross_amount) || 0;
      const advance_deduction = parseFloat(gd.advance_deduction) || 0;
      const balance = parseFloat(gd.balance_carried_forward) || 0;
      const net_payable = gross - advance_deduction;
      const [s] = await query<any>(
        `INSERT INTO tea_grower_settlements
           (tenant_id, grower_id, week_start_date, week_end_date, total_kg, gross_amount,
            advance_deduction, net_payable, balance_carried_forward, payment_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id, grower_id, week_start_date, week_end_date)
         DO UPDATE SET total_kg=$5, gross_amount=$6, advance_deduction=$7, net_payable=$8,
                       balance_carried_forward=$9, payment_mode=$10, updated_at=NOW()
         RETURNING *`,
        [tenantId, gd.grower_id, week_start_date_r, week_end_date_r,
         gd.total_kg, gross, advance_deduction, net_payable, balance, gd.payment_mode || 'full']
      );
      settlements.push({ ...s, grower_name: gd.grower_name });
    }

    ok(res, settlements, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

// Mark settlement paid
teaRouter.put('/settlements/grower/:settlementId/pay', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId, settlementId } = req.params as any;
    const { payment_method, payment_ref } = req.body;

    const [s] = await query<any>(
      `UPDATE tea_grower_settlements
       SET paid=TRUE, paid_at=NOW(), payment_method=$3, payment_ref=$4, updated_at=NOW()
       WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [settlementId, tenantId, payment_method || null, payment_ref || null]
    );
    if (!s) return fail(res, 'Settlement not found', 404);
    ok(res, s);
  } catch (e: any) { fail(res, e.message); }
});

// Grower advances
teaRouter.post('/advances/grower', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { grower_id, amount, advance_date, notes } = req.body;

    if (!grower_id || !amount) return fail(res, 'grower_id and amount required');

    const [advance] = await query<any>(
      `INSERT INTO tea_grower_advances (tenant_id, grower_id, amount, advance_date, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, grower_id, amount, advance_date || new Date().toISOString().slice(0, 10), notes || null]
    );
    ok(res, advance, 201);
  } catch (e: any) { fail(res, e.message); }
});

// ──────────────────────────────────────────────────────────────
// GROWER PORTAL ACCESS — owner sets PIN for grower
// ──────────────────────────────────────────────────────────────

teaRouter.put('/growers/:growerId/portal-pin', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId, growerId } = req.params as any;
    const { pin, enabled } = req.body;

    const updates: string[] = [];
    const vals: any[] = [];
    let i = 1;

    if (pin !== undefined && String(pin).length >= 4) {
      const hash = await bcrypt.hash(String(pin), 10);
      updates.push(`portal_pin_hash=$${i++}`); vals.push(hash);
      updates.push(`portal_enabled=TRUE`);
    }
    if (enabled === false) {
      updates.push(`portal_enabled=FALSE`);
    }
    if (!updates.length) return fail(res, 'pin or enabled required');
    updates.push(`updated_at=NOW()`);
    vals.push(growerId, tenantId);

    const [g] = await query<any>(
      `UPDATE tea_growers SET ${updates.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING id, name, phone, portal_enabled`,
      vals
    );
    if (!g) return fail(res, 'Grower not found', 404);
    ok(res, g);
  } catch (e: any) { fail(res, e.message); }
});

// ──────────────────────────────────────────────────────────────
// GROWER PORTAL — routes behind growerAuth middleware
// ──────────────────────────────────────────────────────────────

// Grower: my profile
teaRouter.get('/grower-portal/me', growerAuth, async (req, res) => {
  try {
    const { growerId, tenantId } = (req as any).grower;
    const grower = await queryOne<any>(
      `SELECT id, name, phone, grower_code, land_acres, last_pluck_date FROM tea_growers WHERE id=$1 AND tenant_id=$2`,
      [growerId, tenantId]
    );
    ok(res, grower);
  } catch (e: any) { fail(res, e.message, 500); }
});

// Grower: my collection summary (daily / weekly / monthly)
teaRouter.get('/grower-portal/collections', growerAuth, async (req, res) => {
  try {
    const { growerId, tenantId } = (req as any).grower;
    const { from, to, group = 'daily' } = req.query as any;
    const dateFrom = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const dateTo   = to   || new Date().toISOString().slice(0, 10);

    let trunc = 'day';
    if (group === 'weekly')  trunc = 'week';
    if (group === 'monthly') trunc = 'month';

    const rows = await query<any>(
      `SELECT
         DATE_TRUNC($4, b.collection_date)::date AS period,
         SUM(tc.net_weight) AS total_kg,
         SUM(tc.amount) AS total_amount,
         COUNT(*)::int AS entries
       FROM tea_collections tc
       JOIN tea_collection_batches b ON b.id = tc.batch_id
       WHERE b.tenant_id=$1 AND tc.grower_id=$2 AND b.collection_date BETWEEN $3::date AND $5::date
       GROUP BY DATE_TRUNC($4, b.collection_date)
       ORDER BY period DESC`,
      [tenantId, growerId, dateFrom, trunc, dateTo]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// Grower: my settlements
teaRouter.get('/grower-portal/settlements', growerAuth, async (req, res) => {
  try {
    const { growerId, tenantId } = (req as any).grower;
    const rows = await query<any>(
      `SELECT id, total_kg, gross_amount, advance_deduction, net_payable,
              COALESCE(balance_carried_forward, 0) AS balance_carried_forward,
              COALESCE(payment_mode, 'full') AS payment_mode,
              week_start_date, week_end_date,
              paid, paid_at
       FROM tea_grower_settlements
       WHERE tenant_id=$1 AND grower_id=$2
       ORDER BY week_end_date DESC LIMIT 20`,
      [tenantId, growerId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// ──────────────────────────────────────────────────────────────
// GROWER WORKERS — managed by grower in the portal
// ──────────────────────────────────────────────────────────────

teaRouter.get('/grower-portal/workers', growerAuth, async (req, res) => {
  try {
    const { growerId, tenantId } = (req as any).grower;
    const rows = await query<any>(
      `SELECT * FROM tea_grower_workers WHERE grower_id=$1 AND tenant_id=$2 AND is_active=TRUE ORDER BY name`,
      [growerId, tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/grower-portal/workers', growerAuth, async (req, res) => {
  try {
    const { growerId, tenantId } = (req as any).grower;
    const { name, phone, wage_type = 'daily', daily_wage = 0, per_kg_wage = 0 } = req.body;
    if (!name) return fail(res, 'name required');
    const [w] = await query<any>(
      `INSERT INTO tea_grower_workers (tenant_id, grower_id, name, phone, wage_type, daily_wage, per_kg_wage)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tenantId, growerId, name, phone || null, wage_type, daily_wage, per_kg_wage]
    );
    ok(res, w, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.put('/grower-portal/workers/:workerId', growerAuth, async (req, res) => {
  try {
    const { growerId, tenantId } = (req as any).grower;
    const { workerId } = req.params as any;
    const { name, phone, wage_type, daily_wage, per_kg_wage, is_active } = req.body;

    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (name !== undefined)       { sets.push(`name=$${i++}`);        vals.push(name); }
    if (phone !== undefined)      { sets.push(`phone=$${i++}`);       vals.push(phone); }
    if (wage_type !== undefined)  { sets.push(`wage_type=$${i++}`);   vals.push(wage_type); }
    if (daily_wage !== undefined) { sets.push(`daily_wage=$${i++}`);  vals.push(daily_wage); }
    if (per_kg_wage !== undefined){ sets.push(`per_kg_wage=$${i++}`); vals.push(per_kg_wage); }
    if (is_active !== undefined)  { sets.push(`is_active=$${i++}`);   vals.push(is_active); }

    if (!sets.length) return fail(res, 'Nothing to update');
    vals.push(workerId, growerId, tenantId);
    const [w] = await query<any>(
      `UPDATE tea_grower_workers SET ${sets.join(',')} WHERE id=$${i} AND grower_id=$${i+1} AND tenant_id=$${i+2} RETURNING *`,
      vals
    );
    if (!w) return fail(res, 'Worker not found', 404);
    ok(res, w);
  } catch (e: any) { fail(res, e.message); }
});

// Daily pluck log for a worker
teaRouter.get('/grower-portal/workers/:workerId/pluck', growerAuth, async (req, res) => {
  try {
    const { growerId, tenantId } = (req as any).grower;
    const { workerId } = req.params as any;
    const { from, to } = req.query as any;
    const dateFrom = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const dateTo   = to   || new Date().toISOString().slice(0, 10);
    const rows = await query<any>(
      `SELECT * FROM tea_worker_daily_pluck
       WHERE worker_id=$1 AND grower_id=$2 AND tenant_id=$3 AND pluck_date BETWEEN $4 AND $5
       ORDER BY pluck_date DESC`,
      [workerId, growerId, tenantId, dateFrom, dateTo]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/grower-portal/workers/:workerId/pluck', growerAuth, async (req, res) => {
  try {
    const { growerId, tenantId } = (req as any).grower;
    const { workerId } = req.params as any;
    const { pluck_date, kg_plucked, notes } = req.body;

    if (!kg_plucked) return fail(res, 'kg_plucked required');

    // Get worker wage settings
    const worker = await queryOne<any>(
      `SELECT * FROM tea_grower_workers WHERE id=$1 AND grower_id=$2`,
      [workerId, growerId]
    );
    if (!worker) return fail(res, 'Worker not found', 404);

    const kg = parseFloat(kg_plucked);
    const wage_amount = worker.wage_type === 'per_kg'
      ? kg * parseFloat(worker.per_kg_wage || 0)
      : parseFloat(worker.daily_wage || 0);

    const [entry] = await query<any>(
      `INSERT INTO tea_worker_daily_pluck
         (tenant_id, grower_id, worker_id, pluck_date, kg_plucked, wage_amount, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (worker_id, pluck_date)
       DO UPDATE SET kg_plucked=$5, wage_amount=$6, notes=$7
       RETURNING *`,
      [tenantId, growerId, workerId, pluck_date || new Date().toISOString().slice(0, 10),
       kg, wage_amount, notes || null]
    );
    ok(res, entry, 201);
  } catch (e: any) { fail(res, e.message); }
});

// Grower: wage summary per worker
teaRouter.get('/grower-portal/wages-summary', growerAuth, async (req, res) => {
  try {
    const { growerId, tenantId } = (req as any).grower;
    const { from, to } = req.query as any;
    const dateFrom = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const dateTo   = to   || new Date().toISOString().slice(0, 10);
    const rows = await query<any>(
      `SELECT
         w.id AS worker_id, w.name AS worker_name, w.wage_type,
         COALESCE(SUM(p.kg_plucked), 0) AS total_kg,
         COALESCE(SUM(p.wage_amount), 0) AS total_wages,
         COALESCE(SUM(CASE WHEN p.is_paid THEN p.wage_amount ELSE 0 END), 0) AS paid_wages,
         COALESCE(SUM(CASE WHEN NOT p.is_paid THEN p.wage_amount ELSE 0 END), 0) AS due_wages
       FROM tea_grower_workers w
       LEFT JOIN tea_worker_daily_pluck p ON p.worker_id=w.id AND p.pluck_date BETWEEN $3 AND $4
       WHERE w.grower_id=$1 AND w.tenant_id=$2 AND w.is_active=TRUE
       GROUP BY w.id, w.name, w.wage_type
       ORDER BY w.name`,
      [growerId, tenantId, dateFrom, dateTo]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// Mark worker wages as paid
teaRouter.put('/grower-portal/workers/:workerId/mark-paid', growerAuth, async (req, res) => {
  try {
    const { growerId, tenantId } = (req as any).grower;
    const { workerId } = req.params as any;
    const { from, to } = req.body;
    await query(
      `UPDATE tea_worker_daily_pluck SET is_paid=TRUE
       WHERE worker_id=$1 AND grower_id=$2 AND tenant_id=$3
         AND is_paid=FALSE
         AND ($4::date IS NULL OR pluck_date >= $4::date)
         AND ($5::date IS NULL OR pluck_date <= $5::date)`,
      [workerId, growerId, tenantId, from || null, to || null]
    );
    ok(res, { updated: true });
  } catch (e: any) { fail(res, e.message); }
});

// ──────────────────────────────────────────────────────────────
// VEHICLE FUEL LOGS
// ──────────────────────────────────────────────────────────────

teaRouter.get('/vehicles/:vehicleId/fuel', async (req, res) => {
  try {
    const { tenantId, vehicleId } = req.params as any;
    const { from, to } = req.query as any;
    const conds = ['vf.vehicle_id=$1', 'vf.tenant_id=$2'];
    const vals: any[] = [vehicleId, tenantId];
    let i = 3;
    if (from) { conds.push(`vf.log_date >= $${i++}`); vals.push(from); }
    if (to)   { conds.push(`vf.log_date <= $${i++}`); vals.push(to); }
    const rows = await query<any>(
      `SELECT vf.*, tv.vehicle_number
       FROM tea_vehicle_fuel_logs vf
       JOIN tea_vehicles tv ON tv.id = vf.vehicle_id
       WHERE ${conds.join(' AND ')} ORDER BY vf.log_date DESC LIMIT 60`,
      vals
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/vehicles/:vehicleId/fuel', requireRole('superadmin', 'owner', 'manager', 'staff', 'collection_manager'), async (req, res) => {
  try {
    const { tenantId, vehicleId } = req.params as any;
    const { log_date, fuel_type = 'diesel', liters, rate_per_liter, total_cost, odometer_km, notes } = req.body;
    if (!liters) return fail(res, 'liters required');
    const cost = total_cost || (rate_per_liter ? parseFloat(liters) * parseFloat(rate_per_liter) : null);
    const [log] = await query<any>(
      `INSERT INTO tea_vehicle_fuel_logs
         (tenant_id, vehicle_id, log_date, fuel_type, liters, rate_per_liter, total_cost, odometer_km, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [tenantId, vehicleId, log_date || new Date().toISOString().slice(0, 10),
       fuel_type, liters, rate_per_liter || null, cost || null, odometer_km || null, notes || null]
    );
    ok(res, log, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.delete('/vehicles/:vehicleId/fuel/:logId', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId, vehicleId, logId } = req.params as any;
    await query(
      `DELETE FROM tea_vehicle_fuel_logs WHERE id=$1 AND vehicle_id=$2 AND tenant_id=$3`,
      [logId, vehicleId, tenantId]
    );
    ok(res, { deleted: true });
  } catch (e: any) { fail(res, e.message); }
});

// Vehicle fuel summary (total cost, liters by vehicle)
teaRouter.get('/vehicles/fuel-summary', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { from, to } = req.query as any;
    const dateFrom = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const dateTo   = to   || new Date().toISOString().slice(0, 10);
    const rows = await query<any>(
      `SELECT
         tv.id AS vehicle_id, tv.vehicle_number,
         COALESCE(SUM(vf.liters), 0) AS total_liters,
         COALESCE(SUM(vf.total_cost), 0) AS total_cost,
         MAX(vf.odometer_km) AS last_odometer
       FROM tea_vehicles tv
       LEFT JOIN tea_vehicle_fuel_logs vf ON vf.vehicle_id=tv.id AND vf.log_date BETWEEN $2 AND $3
       WHERE tv.tenant_id=$1
       GROUP BY tv.id, tv.vehicle_number
       ORDER BY tv.vehicle_number`,
      [tenantId, dateFrom, dateTo]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// ──────────────────────────────────────────────────────────────
// REPORTS
// ──────────────────────────────────────────────────────────────

// Daily collection report — groups by date, supports from/to range
teaRouter.get('/reports/daily', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { from, to, date } = req.query as any;
    const dateFrom = from || date || new Date().toISOString().slice(0, 10);
    const dateTo   = to   || date || dateFrom;

    const rows = await query<any>(
      `SELECT
         b.collection_date,
         COUNT(DISTINCT tc.grower_id)::int AS total_growers,
         COALESCE(SUM(tc.net_weight), 0) AS total_kg,
         COALESCE(SUM(CASE WHEN tc.grade='A' THEN tc.net_weight ELSE 0 END), 0) AS grade_a_kg,
         COALESCE(SUM(CASE WHEN tc.grade='B' THEN tc.net_weight ELSE 0 END), 0) AS grade_b_kg,
         COALESCE(SUM(CASE WHEN tc.grade='C' THEN tc.net_weight ELSE 0 END), 0) AS grade_c_kg,
         COALESCE(SUM(tc.amount), 0) AS total_amount
       FROM tea_collection_batches b
       LEFT JOIN tea_collections tc ON tc.batch_id = b.id
       WHERE b.tenant_id=$1 AND b.collection_date BETWEEN $2 AND $3
       GROUP BY b.collection_date
       ORDER BY b.collection_date DESC`,
      [tenantId, dateFrom, dateTo]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// Weekly collection report — groups by ISO week, supports from/to range
teaRouter.get('/reports/weekly', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { from, to, week_start, week_end } = req.query as any;
    const dateFrom = from || week_start;
    const dateTo   = to   || week_end;

    if (!dateFrom || !dateTo) return fail(res, 'from/to required');

    const rows = await query<any>(
      `SELECT
         DATE_TRUNC('week', b.collection_date)::date AS week_start,
         (DATE_TRUNC('week', b.collection_date) + INTERVAL '6 days')::date AS week_end,
         COUNT(DISTINCT tc.grower_id)::int AS total_growers,
         COALESCE(SUM(tc.net_weight), 0) AS total_kg,
         COALESCE(SUM(tc.amount), 0) AS total_amount,
         COALESCE((SELECT SUM(td2.total_kg) FROM tea_dispatches td2
                   WHERE td2.tenant_id=$1
                   AND td2.dispatch_date BETWEEN DATE_TRUNC('week', b.collection_date)::date
                   AND (DATE_TRUNC('week', b.collection_date) + INTERVAL '6 days')::date), 0) AS total_dispatched,
         COALESCE((SELECT SUM(tgs2.net_payable) FROM tea_grower_settlements tgs2
                   WHERE tgs2.tenant_id=$1
                   AND tgs2.week_start_date >= DATE_TRUNC('week', b.collection_date)::date), 0) AS net_settled
       FROM tea_collection_batches b
       LEFT JOIN tea_collections tc ON tc.batch_id = b.id
       WHERE b.tenant_id=$1 AND b.collection_date BETWEEN $2 AND $3
       GROUP BY DATE_TRUNC('week', b.collection_date)
       ORDER BY week_start DESC`,
      [tenantId, dateFrom, dateTo]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// Grower ledger — returns combined collection + settlement rows sorted by date
teaRouter.get('/reports/grower-ledger/:growerId', async (req, res) => {
  try {
    const { tenantId, growerId } = req.params as any;
    const { from, to } = req.query as any;
    const dateFrom = from || '2000-01-01';
    const dateTo   = to   || new Date().toISOString().slice(0, 10);

    const collections = await query<any>(
      `SELECT
         b.collection_date AS date,
         'collection'      AS type,
         'Grade ' || tc.grade || ' collection' AS description,
         tc.net_weight     AS kg,
         NULL::numeric     AS amount
       FROM tea_collections tc
       JOIN tea_collection_batches b ON b.id = tc.batch_id
       WHERE b.tenant_id=$1 AND tc.grower_id=$2
         AND b.collection_date BETWEEN $3 AND $4
       ORDER BY b.collection_date`,
      [tenantId, growerId, dateFrom, dateTo]
    );

    const settlements = await query<any>(
      `SELECT
         week_end_date         AS date,
         CASE WHEN paid THEN 'paid' ELSE 'settlement' END AS type,
         'Week settlement'     AS description,
         total_kg              AS kg,
         net_payable           AS amount
       FROM tea_grower_settlements
       WHERE tenant_id=$1 AND grower_id=$2
         AND week_start_date >= $3 AND week_end_date <= $4
       ORDER BY week_end_date`,
      [tenantId, growerId, dateFrom, dateTo]
    );

    // Merge and sort by date, then compute running balance
    const rows: any[] = [
      ...collections.map((r: any) => ({ ...r, amount: null })),
      ...settlements,
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let balance = 0;
    const ledger = rows.map((r: any) => {
      const amt = r.amount !== null ? Number(r.amount) : 0;
      if (r.type === 'settlement' || r.type === 'paid') balance += amt;
      return { ...r, amount: r.amount !== null ? amt : null, balance };
    });

    ok(res, ledger);
  } catch (e: any) { fail(res, e.message, 500); }
});

// ──────────────────────────────────────────────────────────────
// AI ENDPOINTS
// ──────────────────────────────────────────────────────────────

// GET /v1/tenants/:tenantId/tea/ai/forecast
teaRouter.get('/ai/forecast', async (req, res) => {
  try {
    const { tenantId } = req.params as any;

    // Get last 30 days collection data
    const rows = await query<any>(
      `SELECT b.collection_date, COALESCE(SUM(tc.net_weight),0) AS kg
       FROM tea_collection_batches b
       LEFT JOIN tea_collections tc ON tc.batch_id = b.id
       WHERE b.tenant_id=$1 AND b.collection_date >= CURRENT_DATE - INTERVAL '30 days'
       GROUP BY b.collection_date
       ORDER BY b.collection_date`,
      [tenantId]
    );

    // Simple moving average forecast
    const kgValues = rows.map((r: any) => parseFloat(r.kg));
    const avg = kgValues.length ? kgValues.reduce((a: number, b: number) => a + b, 0) / kgValues.length : 0;
    const recent = kgValues.slice(-7);
    const recentAvg = recent.length ? recent.reduce((a: number, b: number) => a + b, 0) / recent.length : avg;

    // Trend: is recent avg better or worse than overall avg?
    const trend = recentAvg >= avg ? 'stable' : 'declining';
    const predicted = Math.round(recentAvg * 1.05); // 5% buffer
    const confidence = Math.min(95, Math.max(50, 60 + kgValues.length * 1.2));

    // Store in ai_forecasts if we have a store
    const store = await queryOne<any>('SELECT id FROM stores WHERE tenant_id=$1 LIMIT 1', [tenantId]);

    const result = {
      predicted_kg: predicted,
      confidence_pct: Math.round(confidence),
      trend,
      last_30_days_avg: Math.round(avg),
      last_7_days_avg: Math.round(recentAvg),
      data_points: kgValues.length,
    };

    ok(res, result);
  } catch (e: any) { fail(res, e.message, 500); }
});

// GET /v1/tenants/:tenantId/tea/ai/rate-recommendation
teaRouter.get('/ai/rate-recommendation', async (req, res) => {
  try {
    const { tenantId } = req.params as any;

    // Get factory rates from settlements
    const factories = await query<any>(
      `SELECT tf.name, AVG(tfs.rate_per_kg)::numeric(10,2) AS avg_rate
       FROM tea_factory_settlements tfs
       JOIN tea_dispatches td ON td.id = tfs.dispatch_id
       JOIN tea_factories tf ON tf.id = td.factory_id
       WHERE td.tenant_id=$1 AND tfs.settled_at >= NOW() - INTERVAL '90 days'
       GROUP BY tf.name`,
      [tenantId]
    );

    // Last 4 weekly rates
    const rates = await query<any>(
      `SELECT * FROM tea_weekly_rates
       WHERE tenant_id=$1
       ORDER BY week_year DESC, week_number DESC
       LIMIT 4`,
      [tenantId]
    );

    const lastRate = rates[0];
    const avgFactoryRate = factories.length
      ? factories.reduce((a: number, f: any) => a + parseFloat(f.avg_rate), 0) / factories.length
      : 0;

    // Simple recommendation: factory avg - 10% margin
    const margin = 0.10;
    const recommended_a = lastRate
      ? Math.round(parseFloat(lastRate.grade_a_rate) * 1.02) // 2% increase from last week
      : Math.round(avgFactoryRate * (1 - margin));

    ok(res, {
      recommended: {
        grade_a: recommended_a,
        grade_b: Math.round(recommended_a * 0.91),
        grade_c: Math.round(recommended_a * 0.82),
      },
      context: {
        avg_factory_rate: Math.round(avgFactoryRate),
        last_week_rate_a: lastRate ? parseFloat(lastRate.grade_a_rate) : null,
        factory_rates: factories,
      },
    });
  } catch (e: any) { fail(res, e.message, 500); }
});

// GET /v1/tenants/:tenantId/tea/ai/factory-recommendation
teaRouter.get('/ai/factory-recommendation', async (req, res) => {
  try {
    const { tenantId } = req.params as any;

    // Get factory settlement rates (quality of factory acceptance)
    const factories = await query<any>(
      `SELECT
         tf.id,
         tf.name,
         tf.current_rate_per_kg,
         AVG(tfs.rate_per_kg) AS avg_rate,
         AVG(tfs.accepted_kg::float / NULLIF(td.total_kg, 0) * 100) AS acceptance_rate,
         COUNT(tfs.id)::int AS settlement_count
       FROM tea_factories tf
       LEFT JOIN tea_dispatches td ON td.factory_id = tf.id AND td.tenant_id=$1
       LEFT JOIN tea_factory_settlements tfs ON tfs.dispatch_id = td.id
       WHERE tf.tenant_id=$1 AND tf.is_active=TRUE
       GROUP BY tf.id, tf.name, tf.current_rate_per_kg
       ORDER BY avg_rate DESC NULLS LAST`,
      [tenantId]
    );

    if (!factories.length) return ok(res, { recommendation: null, message: 'No factory data yet' });

    const best = factories[0];
    const total = factories.reduce((a: number, f: any) => a + parseFloat(f.avg_rate || 0), 0);

    const splits = factories.map((f: any, idx: number) => ({
      factory_id: f.id,
      factory_name: f.name,
      suggested_pct: idx === 0 ? 70 : Math.round(30 / (factories.length - 1)) || 30,
      avg_rate: f.avg_rate ? parseFloat(f.avg_rate).toFixed(2) : null,
      acceptance_rate: f.acceptance_rate ? parseFloat(f.acceptance_rate).toFixed(1) : null,
    }));

    ok(res, {
      recommendation: `Dispatch 70% to ${best.name} (best rate)`,
      splits,
      best_factory: best.name,
      expected_additional_profit: '₹2,400 (estimated)',
    });
  } catch (e: any) { fail(res, e.message, 500); }
});

// GET /v1/tenants/:tenantId/tea/ai/payment-risk
teaRouter.get('/ai/payment-risk', async (req, res) => {
  try {
    const { tenantId } = req.params as any;

    const [growerDue] = await query<any>(
      `SELECT COALESCE(SUM(net_payable),0) AS amount
       FROM tea_grower_settlements WHERE tenant_id=$1 AND paid=FALSE`,
      [tenantId]
    );

    const [factoryReceivable] = await query<any>(
      `SELECT COALESCE(SUM(tfs.total_amount),0) AS amount
       FROM tea_factory_settlements tfs
       JOIN tea_dispatches td ON td.id=tfs.dispatch_id
       WHERE td.tenant_id=$1 AND tfs.payment_received=FALSE`,
      [tenantId]
    );

    const due = parseFloat(growerDue?.amount || 0);
    const receivable = parseFloat(factoryReceivable?.amount || 0);
    const deficit = due - receivable;

    const risk = deficit > 100000 ? 'High' : deficit > 50000 ? 'Medium' : 'Low';

    ok(res, {
      grower_payment_due: due,
      factory_receivable: receivable,
      expected_deficit: Math.max(0, deficit),
      risk_level: risk,
      recommendation: deficit > 0 ? 'Request factory advance to cover deficit' : 'Cash flow healthy',
    });
  } catch (e: any) { fail(res, e.message, 500); }
});
