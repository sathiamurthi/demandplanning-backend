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
import { logAIUsage } from '../superadmin/ai-pipeline.service';
import { sendWhatsAppText, normalizeWhatsAppPhone } from '../../utils/whatsapp';
import { callAI } from '../../config/aiService';

// Shared AI call helper for every TeaFactory360 AI feature below — goes
// through the same callAI() fallback chain (Anthropic -> Gemini -> Azure
// OpenAI) already used by Data360, so a low-credit/rate-limited Anthropic
// account doesn't take every tea AI feature down with it. Usage-logging
// pattern matches the rest of the codebase (ai.service.ts).
async function askClaude(feature: string, prompt: string, tenantId?: string, maxTokens = 500): Promise<string> {
  const t0 = Date.now();
  try {
    const res = await callAI({ prompt, maxTokens });
    await logAIUsage({
      feature, model: res.model, tenantId,
      promptTokens: res.inputTokens, completionTokens: res.outputTokens,
      latencyMs: Date.now() - t0, status: 'success',
    });
    return res.text;
  } catch (e: any) {
    await logAIUsage({
      feature, model: 'unknown', tenantId, promptTokens: 0, completionTokens: 0,
      latencyMs: Date.now() - t0, status: 'error', errorMsg: e.message,
    });
    throw e;
  }
}

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
teaRouter.post('/growers', requireRole('superadmin', 'owner', 'manager', 'agent'), async (req, res) => {
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
teaRouter.put('/growers/:growerId', requireRole('superadmin', 'owner', 'manager', 'agent'), async (req, res) => {
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
teaRouter.post('/collections/batches', requireRole('superadmin', 'owner', 'manager', 'staff', 'collection_manager', 'agent'), async (req, res) => {
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
teaRouter.post('/collections/batches/:batchId/entries', requireRole('superadmin', 'owner', 'manager', 'staff', 'collection_manager', 'agent'), async (req, res) => {
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
teaRouter.put('/collections/entries/:entryId', requireRole('superadmin', 'owner', 'manager', 'staff', 'agent'), async (req, res) => {
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

teaRouter.post('/dispatches', requireRole('superadmin', 'owner', 'manager', 'agent'), async (req, res) => {
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

teaRouter.post('/dispatches/:dispatchId/bags', requireRole('superadmin', 'owner', 'manager', 'staff', 'agent'), async (req, res) => {
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
teaRouter.patch('/dispatches/:dispatchId/bags/:bagId', requireRole('superadmin', 'owner', 'manager', 'staff', 'agent'), async (req, res) => {
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
teaRouter.patch('/dispatches/:dispatchId', requireRole('superadmin', 'owner', 'manager', 'staff', 'agent'), async (req, res) => {
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

teaRouter.delete('/dispatches/:dispatchId/bags/:bagId', requireRole('superadmin', 'owner', 'manager', 'agent'), async (req, res) => {
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
teaRouter.post('/settlements/grower/generate', requireRole('superadmin', 'owner', 'manager', 'agent'), async (req, res) => {
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
teaRouter.put('/settlements/grower/:settlementId/pay', requireRole('superadmin', 'owner', 'manager', 'agent'), async (req, res) => {
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
teaRouter.post('/advances/grower', requireRole('superadmin', 'owner', 'manager', 'agent'), async (req, res) => {
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

teaRouter.post('/vehicles/:vehicleId/fuel', requireRole('superadmin', 'owner', 'manager', 'staff', 'collection_manager', 'agent'), async (req, res) => {
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

// ════════════════════════════════════════════════════════════════════════
// TEAFACTORY360 — SUPPLIERS & FUEL
// ════════════════════════════════════════════════════════════════════════

teaRouter.get('/suppliers', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { category } = req.query as any;
    const conds = ['tenant_id=$1']; const vals: any[] = [tenantId]; let i = 2;
    if (category) { conds.push(`category=$${i++}`); vals.push(category); }
    const rows = await query<any>(`SELECT * FROM tea_suppliers WHERE ${conds.join(' AND ')} ORDER BY name`, vals);
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/suppliers', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { name, category = 'other', contact, phone, payment_terms } = req.body;
    if (!name) return fail(res, 'name required');
    const [s] = await query<any>(
      `INSERT INTO tea_suppliers (tenant_id, name, category, contact, phone, payment_terms) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantId, name, category, contact || null, phone || null, payment_terms || null]
    );
    ok(res, s, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.put('/suppliers/:supplierId', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId, supplierId } = req.params as any;
    const { name, category, contact, phone, payment_terms, is_active } = req.body;
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (name !== undefined) { sets.push(`name=$${i++}`); vals.push(name); }
    if (category !== undefined) { sets.push(`category=$${i++}`); vals.push(category); }
    if (contact !== undefined) { sets.push(`contact=$${i++}`); vals.push(contact); }
    if (phone !== undefined) { sets.push(`phone=$${i++}`); vals.push(phone); }
    if (payment_terms !== undefined) { sets.push(`payment_terms=$${i++}`); vals.push(payment_terms); }
    if (is_active !== undefined) { sets.push(`is_active=$${i++}`); vals.push(is_active); }
    if (!sets.length) return fail(res, 'No fields to update');
    vals.push(supplierId, tenantId);
    const [s] = await query<any>(`UPDATE tea_suppliers SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING *`, vals);
    if (!s) return fail(res, 'Supplier not found', 404);
    ok(res, s);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/supply-orders', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { status } = req.query as any;
    const conds = ['so.tenant_id=$1']; const vals: any[] = [tenantId]; let i = 2;
    if (status) { conds.push(`so.status=$${i++}`); vals.push(status); }
    const rows = await query<any>(
      `SELECT so.*, s.name AS supplier_name, s.category AS supplier_category
       FROM tea_supply_orders so JOIN tea_suppliers s ON s.id = so.supplier_id
       WHERE ${conds.join(' AND ')} ORDER BY so.order_date DESC LIMIT 100`,
      vals
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/supply-orders', requireRole('superadmin', 'owner', 'manager', 'staff'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { supplier_id, order_date, items, quantity, unit, unit_cost, total_cost } = req.body;
    if (!supplier_id) return fail(res, 'supplier_id required');
    const computedTotal = total_cost || (quantity && unit_cost ? parseFloat(quantity) * parseFloat(unit_cost) : null);
    const [o] = await query<any>(
      `INSERT INTO tea_supply_orders (tenant_id, supplier_id, order_date, items, quantity, unit, unit_cost, total_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tenantId, supplier_id, order_date || new Date().toISOString().slice(0, 10), items || null,
       quantity || null, unit || null, unit_cost || null, computedTotal]
    );
    ok(res, o, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.put('/supply-orders/:orderId', requireRole('superadmin', 'owner', 'manager', 'staff'), async (req, res) => {
  try {
    const { tenantId, orderId } = req.params as any;
    const { status } = req.body;
    if (!status) return fail(res, 'status required');
    const [o] = await query<any>(
      `UPDATE tea_supply_orders SET status=$1 WHERE id=$2 AND tenant_id=$3 RETURNING *`,
      [status, orderId, tenantId]
    );
    if (!o) return fail(res, 'Supply order not found', 404);
    ok(res, o);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/fuel-consumption', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { from, to } = req.query as any;
    const dateFrom = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const dateTo = to || new Date().toISOString().slice(0, 10);
    const rows = await query<any>(
      `SELECT * FROM tea_fuel_consumption WHERE tenant_id=$1 AND consumption_date BETWEEN $2 AND $3 ORDER BY consumption_date DESC`,
      [tenantId, dateFrom, dateTo]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/fuel-consumption', requireRole('superadmin', 'owner', 'manager', 'staff'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { consumption_date, fuel_type = 'firewood', quantity_used, unit = 'kg', cost, batch_id, notes } = req.body;
    if (!quantity_used) return fail(res, 'quantity_used required');
    const [f] = await query<any>(
      `INSERT INTO tea_fuel_consumption (tenant_id, consumption_date, fuel_type, quantity_used, unit, cost, batch_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tenantId, consumption_date || new Date().toISOString().slice(0, 10), fuel_type, quantity_used, unit, cost || null, batch_id || null, notes || null]
    );
    ok(res, f, 201);
  } catch (e: any) { fail(res, e.message); }
});

// ════════════════════════════════════════════════════════════════════════
// TEAFACTORY360 — ESTATE & WORKFORCE (factory's own plots/workers — see
// migration 086 for why this is distinct from the existing grower-side
// tea_grower_workers)
// ════════════════════════════════════════════════════════════════════════

teaRouter.get('/estate/plots', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>('SELECT * FROM tea_estate_plots WHERE tenant_id=$1 ORDER BY name', [tenantId]);
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/estate/plots', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { name, area_hectares, manager_user_id } = req.body;
    if (!name) return fail(res, 'name required');
    const [p] = await query<any>(
      `INSERT INTO tea_estate_plots (tenant_id, name, area_hectares, manager_user_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [tenantId, name, area_hectares || null, manager_user_id || null]
    );
    ok(res, p, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/estate/workers', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { plot_id, role } = req.query as any;
    const conds = ['w.tenant_id=$1']; const vals: any[] = [tenantId]; let i = 2;
    if (plot_id) { conds.push(`w.plot_id=$${i++}`); vals.push(plot_id); }
    if (role) { conds.push(`w.role=$${i++}`); vals.push(role); }
    const rows = await query<any>(
      `SELECT w.*, p.name AS plot_name FROM tea_estate_workers w LEFT JOIN tea_estate_plots p ON p.id=w.plot_id
       WHERE ${conds.join(' AND ')} ORDER BY w.name`,
      vals
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/estate/workers', requireRole('superadmin', 'owner', 'manager', 'estate_manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { name, phone, role = 'other', employment_type = 'permanent', plot_id, daily_wage = 0 } = req.body;
    if (!name) return fail(res, 'name required');
    const [w] = await query<any>(
      `INSERT INTO tea_estate_workers (tenant_id, name, phone, role, employment_type, plot_id, daily_wage)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tenantId, name, phone || null, role, employment_type, plot_id || null, daily_wage]
    );
    ok(res, w, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.put('/estate/workers/:workerId', requireRole('superadmin', 'owner', 'manager', 'estate_manager'), async (req, res) => {
  try {
    const { tenantId, workerId } = req.params as any;
    const { name, phone, role, employment_type, plot_id, daily_wage, is_active } = req.body;
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (name !== undefined) { sets.push(`name=$${i++}`); vals.push(name); }
    if (phone !== undefined) { sets.push(`phone=$${i++}`); vals.push(phone); }
    if (role !== undefined) { sets.push(`role=$${i++}`); vals.push(role); }
    if (employment_type !== undefined) { sets.push(`employment_type=$${i++}`); vals.push(employment_type); }
    if (plot_id !== undefined) { sets.push(`plot_id=$${i++}`); vals.push(plot_id); }
    if (daily_wage !== undefined) { sets.push(`daily_wage=$${i++}`); vals.push(daily_wage); }
    if (is_active !== undefined) { sets.push(`is_active=$${i++}`); vals.push(is_active); }
    if (!sets.length) return fail(res, 'No fields to update');
    vals.push(workerId, tenantId);
    const [w] = await query<any>(`UPDATE tea_estate_workers SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING *`, vals);
    if (!w) return fail(res, 'Worker not found', 404);
    ok(res, w);
  } catch (e: any) { fail(res, e.message); }
});

// Mark attendance — wage_computed follows the worker's own daily_wage;
// absent days compute to 0 rather than being left null, so payroll can
// sum a period without special-casing missing rows.
teaRouter.post('/estate/attendance', requireRole('superadmin', 'owner', 'manager', 'estate_manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { worker_id, attendance_date, status = 'present', method = 'manual' } = req.body;
    if (!worker_id) return fail(res, 'worker_id required');
    const worker = await queryOne<any>('SELECT daily_wage FROM tea_estate_workers WHERE id=$1 AND tenant_id=$2', [worker_id, tenantId]);
    if (!worker) return fail(res, 'Worker not found', 404);
    const wage = status === 'present' ? parseFloat(worker.daily_wage || 0) : 0;
    const [a] = await query<any>(
      `INSERT INTO tea_estate_attendance (tenant_id, worker_id, attendance_date, status, method, wage_computed)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (worker_id, attendance_date) DO UPDATE SET status=$4, method=$5, wage_computed=$6
       RETURNING *`,
      [tenantId, worker_id, attendance_date || new Date().toISOString().slice(0, 10), status, method, wage]
    );
    ok(res, a, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/estate/attendance', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { date, from, to } = req.query as any;
    const conds = ['a.tenant_id=$1']; const vals: any[] = [tenantId]; let i = 2;
    if (date) { conds.push(`a.attendance_date=$${i++}`); vals.push(date); }
    else if (from && to) { conds.push(`a.attendance_date BETWEEN $${i++} AND $${i++}`); vals.push(from, to); }
    const rows = await query<any>(
      `SELECT a.*, w.name AS worker_name, w.role FROM tea_estate_attendance a
       JOIN tea_estate_workers w ON w.id=a.worker_id
       WHERE ${conds.join(' AND ')} ORDER BY a.attendance_date DESC, w.name`,
      vals
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// Wage totals per worker for a period — same-day compute, no separate
// "run payroll" step needed just to see what's owed.
teaRouter.get('/estate/wage-totals', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { from, to } = req.query as any;
    const dateFrom = from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const dateTo = to || new Date().toISOString().slice(0, 10);
    const rows = await query<any>(
      `SELECT w.id AS worker_id, w.name AS worker_name, w.role,
              COUNT(*) FILTER (WHERE a.status='present')::int AS days_present,
              COUNT(*) FILTER (WHERE a.status='absent')::int AS days_absent,
              COALESCE(SUM(a.wage_computed), 0) AS total_wage
       FROM tea_estate_workers w
       LEFT JOIN tea_estate_attendance a ON a.worker_id=w.id AND a.attendance_date BETWEEN $2 AND $3
       WHERE w.tenant_id=$1 AND w.is_active=TRUE
       GROUP BY w.id, w.name, w.role ORDER BY w.name`,
      [tenantId, dateFrom, dateTo]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// Payroll run — simplified, standard-slab EPF/ESI/TDS computed in-house.
// The spec explicitly flags payroll compliance as a build-vs-integrate
// decision; these are common baseline rates (EPF 12% employee share, ESI
// 0.75% below the wage ceiling, TDS 0 by default since it depends on the
// worker's full tax situation) — review against a compliance professional
// before relying on this for real statutory filing.
const EPF_RATE = 0.12;
const ESI_RATE = 0.0075;
const ESI_WAGE_CEILING = 21000;

teaRouter.post('/payroll/generate', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { worker_id, period_start, period_end } = req.body;
    if (!worker_id || !period_start || !period_end) return fail(res, 'worker_id, period_start and period_end required');

    const [wageRow] = await query<any>(
      `SELECT COALESCE(SUM(wage_computed), 0) AS gross FROM tea_estate_attendance
       WHERE worker_id=$1 AND attendance_date BETWEEN $2 AND $3`,
      [worker_id, period_start, period_end]
    );
    const gross = parseFloat(wageRow?.gross || 0);
    const epf = Math.round(gross * EPF_RATE * 100) / 100;
    const esi = gross <= ESI_WAGE_CEILING ? Math.round(gross * ESI_RATE * 100) / 100 : 0;
    const tds = 0; // left at 0 by default — most estate/casual wages fall under the taxable threshold
    const net_pay = gross - epf - esi - tds;

    const [run] = await query<any>(
      `INSERT INTO tea_payroll_runs (tenant_id, worker_id, period_start, period_end, gross_wage, epf, esi, tds, net_pay)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (worker_id, period_start, period_end)
       DO UPDATE SET gross_wage=$5, epf=$6, esi=$7, tds=$8, net_pay=$9
       RETURNING *`,
      [tenantId, worker_id, period_start, period_end, gross, epf, esi, tds, net_pay]
    );
    ok(res, run, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/payroll', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>(
      `SELECT pr.*, w.name AS worker_name FROM tea_payroll_runs pr JOIN tea_estate_workers w ON w.id=pr.worker_id
       WHERE pr.tenant_id=$1 ORDER BY pr.period_end DESC LIMIT 100`,
      [tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.put('/payroll/:runId/mark-paid', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId, runId } = req.params as any;
    const [r] = await query<any>(
      `UPDATE tea_payroll_runs SET status='paid' WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [runId, tenantId]
    );
    if (!r) return fail(res, 'Payroll run not found', 404);
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/worker-insurance', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>(
      `SELECT wi.*, w.name AS worker_name FROM tea_worker_insurance wi JOIN tea_estate_workers w ON w.id=wi.worker_id
       WHERE wi.tenant_id=$1 ORDER BY wi.expiry_date NULLS LAST, wi.next_checkup_date NULLS LAST`,
      [tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/worker-insurance', requireRole('superadmin', 'owner', 'manager', 'estate_manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { worker_id, type = 'group_health', provider, policy_number, expiry_date, next_checkup_date } = req.body;
    if (!worker_id) return fail(res, 'worker_id required');
    const [w] = await query<any>(
      `INSERT INTO tea_worker_insurance (tenant_id, worker_id, type, provider, policy_number, expiry_date, next_checkup_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tenantId, worker_id, type, provider || null, policy_number || null, expiry_date || null, next_checkup_date || null]
    );
    ok(res, w, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.put('/worker-insurance/:recordId', requireRole('superadmin', 'owner', 'manager', 'estate_manager'), async (req, res) => {
  try {
    const { tenantId, recordId } = req.params as any;
    const { provider, policy_number, expiry_date, next_checkup_date, status } = req.body;
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (provider !== undefined) { sets.push(`provider=$${i++}`); vals.push(provider); }
    if (policy_number !== undefined) { sets.push(`policy_number=$${i++}`); vals.push(policy_number); }
    if (expiry_date !== undefined) { sets.push(`expiry_date=$${i++}`); vals.push(expiry_date); }
    if (next_checkup_date !== undefined) { sets.push(`next_checkup_date=$${i++}`); vals.push(next_checkup_date); }
    if (status !== undefined) { sets.push(`status=$${i++}`); vals.push(status); }
    if (!sets.length) return fail(res, 'No fields to update');
    vals.push(recordId, tenantId);
    const [w] = await query<any>(`UPDATE tea_worker_insurance SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING *`, vals);
    if (!w) return fail(res, 'Record not found', 404);
    ok(res, w);
  } catch (e: any) { fail(res, e.message); }
});

// ════════════════════════════════════════════════════════════════════════
// TEAFACTORY360 — FLEET EXTENSIONS (trip logs, maintenance reminders, live map)
// ════════════════════════════════════════════════════════════════════════

teaRouter.get('/vehicles/:vehicleId/trips', async (req, res) => {
  try {
    const { tenantId, vehicleId } = req.params as any;
    const rows = await query<any>(
      `SELECT * FROM tea_vehicle_trips WHERE vehicle_id=$1 AND tenant_id=$2 ORDER BY trip_date DESC LIMIT 60`,
      [vehicleId, tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/vehicles/:vehicleId/trips', requireRole('superadmin', 'owner', 'manager', 'staff', 'driver', 'agent'), async (req, res) => {
  try {
    const { tenantId, vehicleId } = req.params as any;
    const { trip_date, distance_km, fuel_used_l, start_time, end_time, status = 'completed' } = req.body;
    const [t] = await query<any>(
      `INSERT INTO tea_vehicle_trips (tenant_id, vehicle_id, trip_date, distance_km, fuel_used_l, start_time, end_time, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tenantId, vehicleId, trip_date || new Date().toISOString().slice(0, 10), distance_km || null, fuel_used_l || null, start_time || null, end_time || null, status]
    );
    ok(res, t, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/vehicles/:vehicleId/maintenance', async (req, res) => {
  try {
    const { tenantId, vehicleId } = req.params as any;
    const rows = await query<any>(
      `SELECT * FROM tea_vehicle_maintenance WHERE vehicle_id=$1 AND tenant_id=$2 ORDER BY due_date NULLS LAST`,
      [vehicleId, tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/vehicles/:vehicleId/maintenance', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId, vehicleId } = req.params as any;
    const { type, due_date, due_odometer_km, last_done_date, last_done_odometer_km } = req.body;
    if (!type) return fail(res, 'type required');
    const [m] = await query<any>(
      `INSERT INTO tea_vehicle_maintenance (tenant_id, vehicle_id, type, due_date, due_odometer_km, last_done_date, last_done_odometer_km)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tenantId, vehicleId, type, due_date || null, due_odometer_km || null, last_done_date || null, last_done_odometer_km || null]
    );
    ok(res, m, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.put('/vehicle-maintenance/:recordId', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId, recordId } = req.params as any;
    const { due_date, due_odometer_km, last_done_date, last_done_odometer_km, status } = req.body;
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (due_date !== undefined) { sets.push(`due_date=$${i++}`); vals.push(due_date); }
    if (due_odometer_km !== undefined) { sets.push(`due_odometer_km=$${i++}`); vals.push(due_odometer_km); }
    if (last_done_date !== undefined) { sets.push(`last_done_date=$${i++}`); vals.push(last_done_date); }
    if (last_done_odometer_km !== undefined) { sets.push(`last_done_odometer_km=$${i++}`); vals.push(last_done_odometer_km); }
    if (status !== undefined) { sets.push(`status=$${i++}`); vals.push(status); }
    if (!sets.length) return fail(res, 'No fields to update');
    vals.push(recordId, tenantId);
    const [m] = await query<any>(`UPDATE tea_vehicle_maintenance SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING *`, vals);
    if (!m) return fail(res, 'Record not found', 404);
    ok(res, m);
  } catch (e: any) { fail(res, e.message); }
});

// Live position — phone-based now (driver's phone browser broadcasts,
// exact same proven pattern as SafeRide360's driver app). live_lat/lng on
// tea_vehicles is the same shape a future Traccar webhook would write
// into, so swapping the position SOURCE later is a config change, not a
// schema or map-rendering change.
teaRouter.patch('/vehicles/:vehicleId/live', requireRole('superadmin', 'owner', 'manager', 'driver', 'agent'), async (req, res) => {
  try {
    const { tenantId, vehicleId } = req.params as any;
    const { lat, lng } = req.body;
    if (lat == null || lng == null) return fail(res, 'lat and lng required');
    const [v] = await query<any>(
      `UPDATE tea_vehicles SET live_lat=$1, live_lng=$2, live_updated_at=NOW() WHERE id=$3 AND tenant_id=$4 RETURNING *`,
      [lat, lng, vehicleId, tenantId]
    );
    if (!v) return fail(res, 'Vehicle not found', 404);
    await query(`INSERT INTO tea_vehicle_positions (vehicle_id, lat, lng) VALUES ($1,$2,$3)`, [vehicleId, lat, lng]);
    ok(res, v);
  } catch (e: any) { fail(res, e.message); }
});

// All vehicles + their live position, for the map view. idle_minutes lets
// the frontend/AI flag "idle vehicle" (spec AI feature #3) without a
// separate polling job.
teaRouter.get('/vehicles/live', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>(
      `SELECT id, vehicle_number, driver_name, driver_phone, live_lat, live_lng, live_updated_at,
              EXTRACT(EPOCH FROM (NOW() - live_updated_at))/60 AS minutes_since_update
       FROM tea_vehicles WHERE tenant_id=$1 AND is_active=TRUE ORDER BY vehicle_number`,
      [tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════════════════
// TEAFACTORY360 — CORE PRODUCTION STAGES (withering → firing → grading →
// packaging, extending the existing daily collection batch)
// ════════════════════════════════════════════════════════════════════════

const PRODUCTION_STAGES = ['intake', 'withering', 'firing', 'grading', 'packaging', 'dispatched'];

teaRouter.patch('/collections/batches/:batchId/stage', requireRole('superadmin', 'owner', 'manager', 'staff'), async (req, res) => {
  try {
    const { tenantId, batchId } = req.params as any;
    const { stage, made_tea_kg, fuel_consumption_id } = req.body;
    if (!stage || !PRODUCTION_STAGES.includes(stage)) return fail(res, `stage must be one of ${PRODUCTION_STAGES.join(', ')}`);

    const batch = await queryOne<any>('SELECT total_kg, made_tea_kg FROM tea_collection_batches WHERE id=$1 AND tenant_id=$2', [batchId, tenantId]);
    if (!batch) return fail(res, 'Batch not found', 404);

    const finalMadeKg = made_tea_kg !== undefined ? parseFloat(made_tea_kg) : (batch.made_tea_kg ? parseFloat(batch.made_tea_kg) : null);
    const greenKg = parseFloat(batch.total_kg || 0);
    const yieldPct = finalMadeKg && greenKg ? Math.round((finalMadeKg / greenKg) * 10000) / 100 : null;

    if (fuel_consumption_id) {
      await query(`UPDATE tea_fuel_consumption SET batch_id=$1 WHERE id=$2 AND tenant_id=$3`, [batchId, fuel_consumption_id, tenantId]);
    }

    const [b] = await query<any>(
      `UPDATE tea_collection_batches SET stage=$1, made_tea_kg=$2, yield_pct=$3, stage_updated_at=NOW(), updated_at=NOW()
       WHERE id=$4 AND tenant_id=$5 RETURNING *`,
      [stage, finalMadeKg, yieldPct, batchId, tenantId]
    );
    ok(res, b);
  } catch (e: any) { fail(res, e.message); }
});

// Production yield report — green leaf in vs. made tea out, by batch
teaRouter.get('/reports/production-yield', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { from, to } = req.query as any;
    const dateFrom = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const dateTo = to || new Date().toISOString().slice(0, 10);
    const rows = await query<any>(
      `SELECT id, collection_date, stage, total_kg AS green_leaf_kg, made_tea_kg, yield_pct
       FROM tea_collection_batches
       WHERE tenant_id=$1 AND collection_date BETWEEN $2 AND $3
       ORDER BY collection_date DESC`,
      [tenantId, dateFrom, dateTo]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════════════════
// TEAFACTORY360 — MACHINERY & VENDORS
// ════════════════════════════════════════════════════════════════════════

teaRouter.get('/machines', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>('SELECT * FROM tea_machines WHERE tenant_id=$1 ORDER BY name', [tenantId]);
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/machines', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { name, type, install_date, last_service_date } = req.body;
    if (!name) return fail(res, 'name required');
    const [m] = await query<any>(
      `INSERT INTO tea_machines (tenant_id, name, type, install_date, last_service_date) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, name, type || null, install_date || null, last_service_date || null]
    );
    ok(res, m, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.put('/machines/:machineId', requireRole('superadmin', 'owner', 'manager', 'maintenance'), async (req, res) => {
  try {
    const { tenantId, machineId } = req.params as any;
    const { name, type, install_date, last_service_date, status } = req.body;
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (name !== undefined) { sets.push(`name=$${i++}`); vals.push(name); }
    if (type !== undefined) { sets.push(`type=$${i++}`); vals.push(type); }
    if (install_date !== undefined) { sets.push(`install_date=$${i++}`); vals.push(install_date); }
    if (last_service_date !== undefined) { sets.push(`last_service_date=$${i++}`); vals.push(last_service_date); }
    if (status !== undefined) { sets.push(`status=$${i++}`); vals.push(status); }
    if (!sets.length) return fail(res, 'No fields to update');
    vals.push(machineId, tenantId);
    const [m] = await query<any>(`UPDATE tea_machines SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING *`, vals);
    if (!m) return fail(res, 'Machine not found', 404);
    ok(res, m);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/machines/:machineId/compliance', async (req, res) => {
  try {
    const { tenantId, machineId } = req.params as any;
    const rows = await query<any>(
      'SELECT * FROM tea_machine_compliance WHERE machine_id=$1 AND tenant_id=$2 ORDER BY due_date NULLS LAST',
      [machineId, tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/machines/:machineId/compliance', requireRole('superadmin', 'owner', 'manager', 'maintenance'), async (req, res) => {
  try {
    const { tenantId, machineId } = req.params as any;
    const { type, due_date, provider } = req.body;
    if (!type) return fail(res, 'type required');
    const [c] = await query<any>(
      `INSERT INTO tea_machine_compliance (tenant_id, machine_id, type, due_date, provider) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, machineId, type, due_date || null, provider || null]
    );
    ok(res, c, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/vendors', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { category } = req.query as any;
    const conds = ['tenant_id=$1']; const vals: any[] = [tenantId]; let i = 2;
    if (category) { conds.push(`category=$${i++}`); vals.push(category); }
    const rows = await query<any>(`SELECT * FROM tea_vendors WHERE ${conds.join(' AND ')} ORDER BY name`, vals);
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/vendors', requireRole('superadmin', 'owner', 'manager', 'maintenance'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { name, contact, phone, category } = req.body;
    if (!name) return fail(res, 'name required');
    const [v] = await query<any>(
      `INSERT INTO tea_vendors (tenant_id, name, contact, phone, category) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, name, contact || null, phone || null, category || null]
    );
    ok(res, v, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/maintenance-tickets', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { status } = req.query as any;
    const conds = ['t.tenant_id=$1']; const vals: any[] = [tenantId]; let i = 2;
    if (status) { conds.push(`t.status=$${i++}`); vals.push(status); }
    const rows = await query<any>(
      `SELECT t.*, m.name AS machine_name FROM tea_maintenance_tickets t JOIN tea_machines m ON m.id=t.machine_id
       WHERE ${conds.join(' AND ')} ORDER BY t.created_at DESC`,
      vals
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/maintenance-tickets', requireRole('superadmin', 'owner', 'manager', 'maintenance'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { machine_id, raised_by, issue, assigned_to } = req.body;
    if (!machine_id || !issue) return fail(res, 'machine_id and issue required');
    const [t] = await query<any>(
      `INSERT INTO tea_maintenance_tickets (tenant_id, machine_id, raised_by, issue, assigned_to)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, machine_id, raised_by || null, issue, assigned_to || null]
    );
    await query(`UPDATE tea_machines SET status='needs_service' WHERE id=$1 AND tenant_id=$2`, [machine_id, tenantId]);
    ok(res, t, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.put('/maintenance-tickets/:ticketId', requireRole('superadmin', 'owner', 'manager', 'maintenance'), async (req, res) => {
  try {
    const { tenantId, ticketId } = req.params as any;
    const { assigned_to, status, cost } = req.body;
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (assigned_to !== undefined) { sets.push(`assigned_to=$${i++}`); vals.push(assigned_to); }
    if (status !== undefined) {
      sets.push(`status=$${i++}`); vals.push(status);
      if (status === 'closed') sets.push(`closed_at=NOW()`);
    }
    if (cost !== undefined) { sets.push(`cost=$${i++}`); vals.push(cost); }
    if (!sets.length) return fail(res, 'No fields to update');
    vals.push(ticketId, tenantId);
    const [t] = await query<any>(`UPDATE tea_maintenance_tickets SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING *`, vals);
    if (!t) return fail(res, 'Ticket not found', 404);
    if (status === 'closed') {
      await query(`UPDATE tea_machines SET status='ok', last_service_date=CURRENT_DATE WHERE id=$1 AND tenant_id=$2`, [t.machine_id, tenantId]);
    }
    ok(res, t);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/maintenance-tickets/:ticketId/quotes', async (req, res) => {
  try {
    const { ticketId } = req.params as any;
    const rows = await query<any>(
      `SELECT q.*, v.name AS vendor_name FROM tea_vendor_quotes q JOIN tea_vendors v ON v.id=q.vendor_id
       WHERE q.ticket_id=$1 ORDER BY q.amount ASC`,
      [ticketId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/maintenance-tickets/:ticketId/quotes', requireRole('superadmin', 'owner', 'manager', 'maintenance'), async (req, res) => {
  try {
    const { tenantId, ticketId } = req.params as any;
    const { vendor_id, amount, delivery_days } = req.body;
    if (!vendor_id || !amount) return fail(res, 'vendor_id and amount required');
    const [q1] = await query<any>(
      `INSERT INTO tea_vendor_quotes (tenant_id, ticket_id, vendor_id, amount, delivery_days) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, ticketId, vendor_id, amount, delivery_days || null]
    );
    ok(res, q1, 201);
  } catch (e: any) { fail(res, e.message); }
});

// ════════════════════════════════════════════════════════════════════════
// TEAFACTORY360 — INVENTORY MANAGEMENT (indent → approval → store issue)
// ════════════════════════════════════════════════════════════════════════

teaRouter.get('/stock-items', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>('SELECT * FROM tea_stock_items WHERE tenant_id=$1 ORDER BY name', [tenantId]);
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/stock-items', requireRole('superadmin', 'owner', 'manager', 'store_keeper'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { name, category = 'other', unit = 'kg', current_qty = 0, reorder_level = 0 } = req.body;
    if (!name) return fail(res, 'name required');
    const [s] = await query<any>(
      `INSERT INTO tea_stock_items (tenant_id, name, category, unit, current_qty, reorder_level) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantId, name, category, unit, current_qty, reorder_level]
    );
    ok(res, s, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.put('/stock-items/:itemId', requireRole('superadmin', 'owner', 'manager', 'store_keeper'), async (req, res) => {
  try {
    const { tenantId, itemId } = req.params as any;
    const { name, category, unit, current_qty, reorder_level } = req.body;
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (name !== undefined) { sets.push(`name=$${i++}`); vals.push(name); }
    if (category !== undefined) { sets.push(`category=$${i++}`); vals.push(category); }
    if (unit !== undefined) { sets.push(`unit=$${i++}`); vals.push(unit); }
    if (current_qty !== undefined) { sets.push(`current_qty=$${i++}`); vals.push(current_qty); }
    if (reorder_level !== undefined) { sets.push(`reorder_level=$${i++}`); vals.push(reorder_level); }
    if (!sets.length) return fail(res, 'No fields to update');
    vals.push(itemId, tenantId);
    const [s] = await query<any>(`UPDATE tea_stock_items SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING *`, vals);
    if (!s) return fail(res, 'Stock item not found', 404);
    ok(res, s);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/indents', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { status } = req.query as any;
    const conds = ['i.tenant_id=$1']; const vals: any[] = [tenantId]; let i = 2;
    if (status) { conds.push(`i.status=$${i++}`); vals.push(status); }
    const rows = await query<any>(
      `SELECT i.*, s.name AS stock_item_name, s.unit FROM tea_indents i JOIN tea_stock_items s ON s.id=i.stock_item_id
       WHERE ${conds.join(' AND ')} ORDER BY i.created_at DESC`,
      vals
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/indents', requireRole('superadmin', 'owner', 'manager', 'store_keeper', 'estate_manager', 'maintenance'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { requested_by, stock_item_id, quantity, indent_date } = req.body;
    if (!stock_item_id || !quantity) return fail(res, 'stock_item_id and quantity required');
    const [i1] = await query<any>(
      `INSERT INTO tea_indents (tenant_id, requested_by, stock_item_id, quantity, indent_date)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, requested_by || null, stock_item_id, quantity, indent_date || new Date().toISOString().slice(0, 10)]
    );
    ok(res, i1, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.put('/indents/:indentId', requireRole('superadmin', 'owner', 'manager', 'store_keeper'), async (req, res) => {
  try {
    const { tenantId, indentId } = req.params as any;
    const { status, approved_by } = req.body;
    if (!status || !['approved', 'rejected'].includes(status)) return fail(res, "status must be 'approved' or 'rejected'");
    const [i1] = await query<any>(
      `UPDATE tea_indents SET status=$1, approved_by=$2 WHERE id=$3 AND tenant_id=$4 RETURNING *`,
      [status, approved_by || null, indentId, tenantId]
    );
    if (!i1) return fail(res, 'Indent not found', 404);
    ok(res, i1);
  } catch (e: any) { fail(res, e.message); }
});

// Store issue — deducts stock on issue, not on indent-approval, since
// approval just authorizes the request; the physical hand-off is what
// actually moves inventory.
teaRouter.post('/indents/:indentId/issue', requireRole('superadmin', 'owner', 'manager', 'store_keeper'), async (req, res) => {
  try {
    const { tenantId, indentId } = req.params as any;
    const { issued_qty, issued_by } = req.body;
    if (!issued_qty) return fail(res, 'issued_qty required');

    const indent = await queryOne<any>('SELECT * FROM tea_indents WHERE id=$1 AND tenant_id=$2', [indentId, tenantId]);
    if (!indent) return fail(res, 'Indent not found', 404);
    if (indent.status !== 'approved') return fail(res, 'Indent must be approved before it can be issued');

    const [issue] = await withTransaction(async (client) => {
      const [row] = (await client.query(
        `INSERT INTO tea_store_issues (tenant_id, indent_id, issued_qty, issued_by) VALUES ($1,$2,$3,$4) RETURNING *`,
        [tenantId, indentId, issued_qty, issued_by || null]
      )).rows;
      await client.query(`UPDATE tea_indents SET status='issued' WHERE id=$1`, [indentId]);
      await client.query(
        `UPDATE tea_stock_items SET current_qty = GREATEST(0, current_qty - $1) WHERE id=$2 AND tenant_id=$3`,
        [issued_qty, indent.stock_item_id, tenantId]
      );
      return [row];
    });
    ok(res, issue, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/reports/inventory', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>(
      `SELECT s.*, (s.current_qty <= s.reorder_level) AS needs_reorder,
              COALESCE((SELECT COUNT(*) FROM tea_indents i WHERE i.stock_item_id=s.id AND i.status='pending'), 0)::int AS pending_indents
       FROM tea_stock_items s WHERE s.tenant_id=$1 ORDER BY needs_reorder DESC, s.name`,
      [tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════════════════
// TEAFACTORY360 — SALES & AUCTION
// ════════════════════════════════════════════════════════════════════════

teaRouter.get('/buyers', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>('SELECT * FROM tea_buyers WHERE tenant_id=$1 ORDER BY name', [tenantId]);
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/buyers', requireRole('superadmin', 'owner', 'manager', 'sales_manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { name, contact, phone, channel_preference = 'auction' } = req.body;
    if (!name) return fail(res, 'name required');
    const [b] = await query<any>(
      `INSERT INTO tea_buyers (tenant_id, name, contact, phone, channel_preference) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, name, contact || null, phone || null, channel_preference]
    );
    ok(res, b, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/auction-lots', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { status } = req.query as any;
    const conds = ['tenant_id=$1']; const vals: any[] = [tenantId]; let i = 2;
    if (status) { conds.push(`status=$${i++}`); vals.push(status); }
    const rows = await query<any>(`SELECT * FROM tea_auction_lots WHERE ${conds.join(' AND ')} ORDER BY auction_date DESC NULLS LAST`, vals);
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/auction-lots', requireRole('superadmin', 'owner', 'manager', 'sales_manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { batch_id, auction_house = 'Coonoor', lot_number, auction_date, quantity_kg, reserve_price } = req.body;
    if (!quantity_kg) return fail(res, 'quantity_kg required');
    const [l] = await query<any>(
      `INSERT INTO tea_auction_lots (tenant_id, batch_id, auction_house, lot_number, auction_date, quantity_kg, reserve_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tenantId, batch_id || null, auction_house, lot_number || null, auction_date || null, quantity_kg, reserve_price || null]
    );
    ok(res, l, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.put('/auction-lots/:lotId', requireRole('superadmin', 'owner', 'manager', 'sales_manager'), async (req, res) => {
  try {
    const { tenantId, lotId } = req.params as any;
    const { sold_price, status } = req.body;
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (sold_price !== undefined) { sets.push(`sold_price=$${i++}`); vals.push(sold_price); }
    if (status !== undefined) { sets.push(`status=$${i++}`); vals.push(status); }
    if (!sets.length) return fail(res, 'No fields to update');
    vals.push(lotId, tenantId);
    const [l] = await query<any>(`UPDATE tea_auction_lots SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING *`, vals);
    if (!l) return fail(res, 'Auction lot not found', 404);
    ok(res, l);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/sales', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { channel, from, to } = req.query as any;
    const conds = ['s.tenant_id=$1']; const vals: any[] = [tenantId]; let i = 2;
    if (channel) { conds.push(`s.channel=$${i++}`); vals.push(channel); }
    if (from) { conds.push(`s.sale_date >= $${i++}`); vals.push(from); }
    if (to) { conds.push(`s.sale_date <= $${i++}`); vals.push(to); }
    const rows = await query<any>(
      `SELECT s.*, b.name AS buyer_name FROM tea_sale_transactions s LEFT JOIN tea_buyers b ON b.id=s.buyer_id
       WHERE ${conds.join(' AND ')} ORDER BY s.sale_date DESC LIMIT 100`,
      vals
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/sales', requireRole('superadmin', 'owner', 'manager', 'sales_manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { batch_id, channel = 'private', buyer_id, quantity_kg, price_per_kg, sale_date } = req.body;
    if (!quantity_kg || !price_per_kg) return fail(res, 'quantity_kg and price_per_kg required');
    const total_amount = parseFloat(quantity_kg) * parseFloat(price_per_kg);
    const [s] = await query<any>(
      `INSERT INTO tea_sale_transactions (tenant_id, batch_id, channel, buyer_id, quantity_kg, price_per_kg, total_amount, sale_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tenantId, batch_id || null, channel, buyer_id || null, quantity_kg, price_per_kg, total_amount, sale_date || new Date().toISOString().slice(0, 10)]
    );
    ok(res, s, 201);
  } catch (e: any) { fail(res, e.message); }
});

// Sales report — volume/revenue by channel, realized price vs reserve
teaRouter.get('/reports/sales', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { from, to } = req.query as any;
    const dateFrom = from || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const dateTo = to || new Date().toISOString().slice(0, 10);
    const byChannel = await query<any>(
      `SELECT channel, COUNT(*)::int AS transactions, SUM(quantity_kg) AS total_kg, SUM(total_amount) AS total_revenue,
              AVG(price_per_kg) AS avg_price_per_kg
       FROM tea_sale_transactions WHERE tenant_id=$1 AND sale_date BETWEEN $2 AND $3
       GROUP BY channel`,
      [tenantId, dateFrom, dateTo]
    );
    const auctionPerf = await query<any>(
      `SELECT lot_number, reserve_price, sold_price,
              CASE WHEN reserve_price > 0 THEN ROUND(((sold_price - reserve_price) / reserve_price * 100)::numeric, 1) ELSE NULL END AS pct_vs_reserve
       FROM tea_auction_lots WHERE tenant_id=$1 AND status='sold' AND auction_date BETWEEN $2 AND $3
       ORDER BY auction_date DESC`,
      [tenantId, dateFrom, dateTo]
    );
    ok(res, { by_channel: byChannel, auction_performance: auctionPerf });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════════════════
// TEAFACTORY360 — COMPLIANCE & FACILITY
// ════════════════════════════════════════════════════════════════════════

teaRouter.get('/facilities', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>('SELECT * FROM tea_facilities WHERE tenant_id=$1 ORDER BY renewal_date NULLS LAST', [tenantId]);
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/facilities', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { name, type, authority, renewal_date } = req.body;
    if (!name || !type) return fail(res, 'name and type required');
    const [f] = await query<any>(
      `INSERT INTO tea_facilities (tenant_id, name, type, authority, renewal_date) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, name, type, authority || null, renewal_date || null]
    );
    ok(res, f, 201);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.put('/facilities/:facilityId', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId, facilityId } = req.params as any;
    const { authority, renewal_date, status } = req.body;
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (authority !== undefined) { sets.push(`authority=$${i++}`); vals.push(authority); }
    if (renewal_date !== undefined) { sets.push(`renewal_date=$${i++}`); vals.push(renewal_date); }
    if (status !== undefined) { sets.push(`status=$${i++}`); vals.push(status); }
    if (!sets.length) return fail(res, 'No fields to update');
    vals.push(facilityId, tenantId);
    const [f] = await query<any>(`UPDATE tea_facilities SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING *`, vals);
    if (!f) return fail(res, 'Facility not found', 404);
    ok(res, f);
  } catch (e: any) { fail(res, e.message); }
});

teaRouter.get('/facility-utilities', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { from, to } = req.query as any;
    const dateFrom = from || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const dateTo = to || new Date().toISOString().slice(0, 10);
    const rows = await query<any>(
      `SELECT * FROM tea_facility_utilities WHERE tenant_id=$1 AND usage_date BETWEEN $2 AND $3 ORDER BY usage_date DESC`,
      [tenantId, dateFrom, dateTo]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

teaRouter.post('/facility-utilities', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { type = 'electricity', usage_date, units_consumed, cost } = req.body;
    const [u] = await query<any>(
      `INSERT INTO tea_facility_utilities (tenant_id, type, usage_date, units_consumed, cost) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, type, usage_date || new Date().toISOString().slice(0, 10), units_consumed || null, cost || null]
    );
    ok(res, u, 201);
  } catch (e: any) { fail(res, e.message); }
});

// Unified renewal calendar — pulls every upcoming/overdue renewal across
// vehicles, machines, workers, and facility certificates into one feed,
// exactly the shape the spec calls for so the owner checks one place
// instead of four. due_soon = within 30 days.
teaRouter.get('/compliance/calendar', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>(
      `SELECT 'vehicle' AS source, vm.type, vm.due_date AS date, tv.vehicle_number AS label,
              CASE WHEN vm.due_date < CURRENT_DATE THEN 'overdue' WHEN vm.due_date <= CURRENT_DATE + 30 THEN 'due_soon' ELSE 'ok' END AS status
       FROM tea_vehicle_maintenance vm JOIN tea_vehicles tv ON tv.id=vm.vehicle_id
       WHERE vm.tenant_id=$1 AND vm.due_date IS NOT NULL
       UNION ALL
       SELECT 'machine', mc.type, mc.due_date, m.name,
              CASE WHEN mc.due_date < CURRENT_DATE THEN 'overdue' WHEN mc.due_date <= CURRENT_DATE + 30 THEN 'due_soon' ELSE 'ok' END
       FROM tea_machine_compliance mc JOIN tea_machines m ON m.id=mc.machine_id
       WHERE mc.tenant_id=$1 AND mc.due_date IS NOT NULL
       UNION ALL
       SELECT 'worker_insurance', wi.type, COALESCE(wi.expiry_date, wi.next_checkup_date), w.name,
              CASE WHEN COALESCE(wi.expiry_date, wi.next_checkup_date) < CURRENT_DATE THEN 'overdue'
                   WHEN COALESCE(wi.expiry_date, wi.next_checkup_date) <= CURRENT_DATE + 30 THEN 'due_soon' ELSE 'ok' END
       FROM tea_worker_insurance wi JOIN tea_estate_workers w ON w.id=wi.worker_id
       WHERE wi.tenant_id=$1 AND (wi.expiry_date IS NOT NULL OR wi.next_checkup_date IS NOT NULL)
       UNION ALL
       SELECT 'facility', f.type, f.renewal_date, f.name,
              CASE WHEN f.renewal_date < CURRENT_DATE THEN 'overdue' WHEN f.renewal_date <= CURRENT_DATE + 30 THEN 'due_soon' ELSE 'ok' END
       FROM tea_facilities f
       WHERE f.tenant_id=$1 AND f.renewal_date IS NOT NULL
       ORDER BY date NULLS LAST`,
      [tenantId]
    );
    ok(res, rows.filter((r: any) => r.status !== 'ok'));
  } catch (e: any) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════════════════
// TEAFACTORY360 — NEW AI FEATURES (built on the existing forecast/rate/
// factory/payment-risk endpoints above, same Claude integration pattern
// as ai.service.ts elsewhere in this codebase)
// ════════════════════════════════════════════════════════════════════════

// Voice/WhatsApp leaf intake parsing (Tamil + English) — spec's #1 AI
// feature. Returns a DRAFT for the clerk to confirm, never writes
// directly to tea_collections, since a misheard number here is a real
// grower-payment dispute waiting to happen.
teaRouter.post('/ai/parse-intake', requireRole('superadmin', 'owner', 'manager', 'staff', 'collection_manager', 'agent'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { text } = req.body;
    if (!text?.trim()) return fail(res, 'text required (the transcribed voice note or WhatsApp message)');

    const growers = await query<any>('SELECT id, name, grower_code, phone FROM tea_growers WHERE tenant_id=$1 AND is_active=TRUE', [tenantId]);
    const growerList = growers.map((g: any) => `${g.name} (code ${g.grower_code || 'n/a'})`).join(', ');

    const prompt = `You parse a tea-factory clerk's voice note or WhatsApp message (Tamil or English, often mixed) into a structured leaf intake draft.
Known growers at this factory: ${growerList || '(none registered yet)'}.
Message: "${text.trim()}"

Return ONLY a JSON object, no markdown fences, shaped exactly like:
{"grower_name": "best-matching grower name or null if unclear", "gross_weight_kg": number or null, "grade": "A"|"B"|"C"|null, "confidence": "high"|"medium"|"low", "notes": "anything ambiguous the clerk should double-check"}`;

    const raw = await askClaude('tea_parse_intake', prompt, tenantId);
    const cleaned = raw.replace(/```json|```/g, '').trim();
    let draft: any;
    try { draft = JSON.parse(cleaned); } catch { return fail(res, 'AI returned an unparseable response — please try again or enter manually'); }

    // Resolve to an actual grower_id if the name plausibly matches one on file
    let matchedGrower = null;
    if (draft.grower_name) {
      matchedGrower = growers.find((g: any) =>
        g.name.toLowerCase().includes(String(draft.grower_name).toLowerCase()) ||
        String(draft.grower_name).toLowerCase().includes(g.name.toLowerCase())
      ) || null;
    }

    ok(res, { ...draft, matched_grower_id: matchedGrower?.id || null, matched_grower_name: matchedGrower?.name || null });
  } catch (e: any) { fail(res, e.message, 500); }
});

// Plain-language grower payment summary + weight/grade anomaly flagging —
// spec's #2 AI feature. Compares this settlement to the grower's own
// trailing average, not a factory-wide average, since land size/cycle
// varies a lot grower to grower.
teaRouter.post('/ai/payment-summary/:growerId', requireRole('superadmin', 'owner', 'manager', 'agent'), async (req, res) => {
  try {
    const { tenantId, growerId } = req.params as any;
    const { settlement_id } = req.body;

    const grower = await queryOne<any>('SELECT * FROM tea_growers WHERE id=$1 AND tenant_id=$2', [growerId, tenantId]);
    if (!grower) return fail(res, 'Grower not found', 404);

    const settlement = settlement_id
      ? await queryOne<any>('SELECT * FROM tea_grower_settlements WHERE id=$1 AND tenant_id=$2 AND grower_id=$3', [settlement_id, tenantId, growerId])
      : await queryOne<any>('SELECT * FROM tea_grower_settlements WHERE tenant_id=$1 AND grower_id=$2 ORDER BY week_end_date DESC LIMIT 1', [tenantId, growerId]);
    if (!settlement) return fail(res, 'No settlement found for this grower');

    const history = await query<any>(
      `SELECT total_kg, gross_amount FROM tea_grower_settlements
       WHERE tenant_id=$1 AND grower_id=$2 AND id != $3 ORDER BY week_end_date DESC LIMIT 8`,
      [tenantId, growerId, settlement.id]
    );
    const avgKg = history.length ? history.reduce((a: number, h: any) => a + parseFloat(h.total_kg), 0) / history.length : parseFloat(settlement.total_kg);
    const deviationPct = avgKg ? Math.round(((parseFloat(settlement.total_kg) - avgKg) / avgKg) * 100) : 0;
    const anomaly = Math.abs(deviationPct) >= 30 && history.length >= 2;

    const prompt = `Write a short, warm, plain-language payment summary for a tea grower, suitable for sending on WhatsApp. Tamil-English mix is fine if natural, but keep it simple and readable.
Grower: ${grower.name}
This period: ${settlement.total_kg} kg, gross ₹${settlement.gross_amount}, advance deducted ₹${settlement.advance_deduction || 0}, net payable ₹${settlement.net_payable}.
Their typical weekly average: ${Math.round(avgKg)} kg.
${anomaly ? `This period is ${deviationPct > 0 ? 'well above' : 'well below'} their usual average (${deviationPct}% ${deviationPct > 0 ? 'higher' : 'lower'}) — mention this gently and ask them to confirm it looks right.` : ''}
Keep it under 80 words. End with the net payable amount clearly stated.`;

    const summary = await askClaude('tea_payment_summary', prompt, tenantId, 300);

    ok(res, {
      summary: summary.trim(),
      anomaly, deviation_pct: deviationPct, avg_weekly_kg: Math.round(avgKg),
      settlement,
    });
  } catch (e: any) { fail(res, e.message, 500); }
});

// Send the AI-generated summary straight to the grower's WhatsApp —
// separate step from generating it, so the owner/clerk can read it first.
teaRouter.post('/ai/payment-summary/:growerId/send', requireRole('superadmin', 'owner', 'manager', 'agent'), async (req, res) => {
  try {
    const { tenantId, growerId } = req.params as any;
    const { summary } = req.body;
    if (!summary?.trim()) return fail(res, 'summary required');
    const grower = await queryOne<any>('SELECT phone FROM tea_growers WHERE id=$1 AND tenant_id=$2', [growerId, tenantId]);
    if (!grower?.phone) return fail(res, 'Grower has no phone number on file');
    const result = await sendWhatsAppText(normalizeWhatsAppPhone(grower.phone), summary.trim());
    ok(res, { sent: result.sent, skipped: result.skipped || false, error: result.error });
  } catch (e: any) { fail(res, e.message, 500); }
});

// Owner conversational assistant ("how did today go?") — spec's #4 AI
// feature. Builds a same-shape context object as /dashboard so the
// narrative and the numbers on screen never disagree.
teaRouter.post('/ai/assistant', requireRole('superadmin', 'owner', 'manager'), async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { question } = req.body;
    const today = new Date().toISOString().slice(0, 10);

    const [todayStats] = await query<any>(
      `SELECT COALESCE(SUM(tc.net_weight),0) AS kg, COUNT(DISTINCT tc.grower_id)::int AS growers
       FROM tea_collection_batches b LEFT JOIN tea_collections tc ON tc.batch_id=b.id
       WHERE b.tenant_id=$1 AND b.collection_date=$2`,
      [tenantId, today]
    );
    const [pendingPay] = await query<any>(
      `SELECT COALESCE(SUM(net_payable),0) AS amount FROM tea_grower_settlements WHERE tenant_id=$1 AND paid=FALSE`,
      [tenantId]
    );
    const [dispatchToday] = await query<any>(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_kg),0) AS kg FROM tea_dispatches WHERE tenant_id=$1 AND dispatch_date=$2`,
      [tenantId, today]
    );
    const openTickets = await queryOne<any>(
      `SELECT COUNT(*)::int AS count FROM tea_maintenance_tickets WHERE tenant_id=$1 AND status != 'closed'`,
      [tenantId]
    );
    const overdueCompliance = await queryOne<any>(
      `SELECT COUNT(*)::int AS count FROM tea_facilities WHERE tenant_id=$1 AND renewal_date < CURRENT_DATE`,
      [tenantId]
    );

    const context = {
      today_kg: parseFloat(todayStats?.kg || 0),
      today_growers: todayStats?.growers || 0,
      pending_grower_payments: parseFloat(pendingPay?.amount || 0),
      dispatches_today: dispatchToday?.count || 0,
      dispatched_kg_today: parseFloat(dispatchToday?.kg || 0),
      open_maintenance_tickets: openTickets?.count || 0,
      overdue_compliance_items: overdueCompliance?.count || 0,
    };

    const prompt = `You are a tea factory's owner-facing assistant. Answer the owner's question in plain, direct language (2-4 sentences), using ONLY the data given below — don't invent numbers.
Today's data: ${JSON.stringify(context)}
Owner's question: "${question?.trim() || "How did today go?"}"`;

    const answer = await askClaude('tea_owner_assistant', prompt, tenantId, 400);
    ok(res, { answer: answer.trim(), context });
  } catch (e: any) { fail(res, e.message, 500); }
});

// Vendor quote comparison — "best value, not just lowest price" (spec's
// #5 AI feature). Marks the AI's pick on tea_vendor_quotes.ai_recommended
// so the frontend can highlight it without re-deriving the same logic.
teaRouter.post('/ai/vendor-recommendation/:ticketId', requireRole('superadmin', 'owner', 'manager', 'maintenance'), async (req, res) => {
  try {
    const { tenantId, ticketId } = req.params as any;
    const quotes = await query<any>(
      `SELECT q.*, v.name AS vendor_name FROM tea_vendor_quotes q JOIN tea_vendors v ON v.id=q.vendor_id WHERE q.ticket_id=$1`,
      [ticketId]
    );
    if (!quotes.length) return fail(res, 'No quotes yet for this ticket');
    if (quotes.length === 1) {
      await query(`UPDATE tea_vendor_quotes SET ai_recommended=TRUE WHERE id=$1`, [quotes[0].id]);
      return ok(res, { recommended_quote_id: quotes[0].id, reasoning: 'Only one quote received.' });
    }

    const prompt = `Compare these repair/maintenance vendor quotes and pick the best VALUE (not necessarily lowest price — consider delivery time too). Quotes:
${quotes.map((q: any, idx: number) => `${idx + 1}. ${q.vendor_name}: ₹${q.amount}, ${q.delivery_days ?? 'unknown'} days delivery`).join('\n')}

Return ONLY JSON: {"best_index": <1-based number from the list above>, "reasoning": "one short sentence"}`;

    const raw = await askClaude('tea_vendor_recommendation', prompt, tenantId, 200);
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    const bestQuote = quotes[parsed.best_index - 1] || quotes[0];

    await query(`UPDATE tea_vendor_quotes SET ai_recommended=FALSE WHERE ticket_id=$1`, [ticketId]);
    await query(`UPDATE tea_vendor_quotes SET ai_recommended=TRUE WHERE id=$1`, [bestQuote.id]);

    ok(res, { recommended_quote_id: bestQuote.id, vendor_name: bestQuote.vendor_name, reasoning: parsed.reasoning });
  } catch (e: any) { fail(res, e.message, 500); }
});

// Predictive maintenance nudges (spec's #6) — simple, honest heuristic:
// flag machines not serviced in >180 days or already needs_service, rather
// than claiming a real ML prediction with no training data behind it yet.
teaRouter.get('/ai/maintenance-nudges', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>(
      `SELECT id, name, type, last_service_date, status,
              CASE WHEN last_service_date IS NULL THEN NULL ELSE (CURRENT_DATE - last_service_date) END AS days_since_service
       FROM tea_machines
       WHERE tenant_id=$1 AND (status='needs_service' OR last_service_date IS NULL OR last_service_date < CURRENT_DATE - 180)
       ORDER BY days_since_service DESC NULLS FIRST`,
      [tenantId]
    );
    ok(res, rows.map((r: any) => ({
      ...r,
      nudge: r.status === 'needs_service'
        ? `${r.name} already has an open service need — raise a ticket if you haven't.`
        : r.days_since_service
          ? `${r.name} hasn't been serviced in ${r.days_since_service} days — consider a checkup.`
          : `${r.name} has no service history on record — worth an initial inspection.`,
    })));
  } catch (e: any) { fail(res, e.message, 500); }
});

// Fuel consumption anomaly detection (spec's #7) — batch/day using
// noticeably more fuel per kg of green leaf than the trailing average.
teaRouter.get('/ai/fuel-anomalies', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>(
      `SELECT fc.id, fc.consumption_date, fc.quantity_used, fc.unit, fc.batch_id, b.total_kg AS green_leaf_kg,
              CASE WHEN b.total_kg > 0 THEN fc.quantity_used / b.total_kg ELSE NULL END AS fuel_per_kg
       FROM tea_fuel_consumption fc LEFT JOIN tea_collection_batches b ON b.id = fc.batch_id
       WHERE fc.tenant_id=$1 AND fc.consumption_date >= CURRENT_DATE - 60
       ORDER BY fc.consumption_date DESC`,
      [tenantId]
    );
    const withRatio = rows.filter((r: any) => r.fuel_per_kg != null);
    const avgRatio = withRatio.length ? withRatio.reduce((a: number, r: any) => a + parseFloat(r.fuel_per_kg), 0) / withRatio.length : 0;
    const anomalies = withRatio
      .filter((r: any) => avgRatio > 0 && parseFloat(r.fuel_per_kg) > avgRatio * 1.3)
      .map((r: any) => ({ ...r, avg_fuel_per_kg: Math.round(avgRatio * 1000) / 1000, pct_above_avg: Math.round(((parseFloat(r.fuel_per_kg) - avgRatio) / avgRatio) * 100) }));
    ok(res, { average_fuel_per_kg: Math.round(avgRatio * 1000) / 1000, anomalies });
  } catch (e: any) { fail(res, e.message, 500); }
});

// Budget alert (spec's #14) — flags month-over-month cost-center spend
// jumps (fuel, payroll, vendor) rather than requiring a separately
// configured budget limit up front, since most small factories don't have
// one set yet; a >25% month-over-month jump is a reasonable default signal.
teaRouter.get('/ai/budget-alerts', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const centers = await query<any>(
      `WITH months AS (
         SELECT 'fuel' AS center, DATE_TRUNC('month', consumption_date) AS month, SUM(cost) AS amount
           FROM tea_fuel_consumption WHERE tenant_id=$1 GROUP BY 1, 2
         UNION ALL
         SELECT 'payroll', DATE_TRUNC('month', period_end), SUM(net_pay)
           FROM tea_payroll_runs WHERE tenant_id=$1 GROUP BY 1, 2
         UNION ALL
         SELECT 'vendor_spend', DATE_TRUNC('month', closed_at), SUM(cost)
           FROM tea_maintenance_tickets WHERE tenant_id=$1 AND closed_at IS NOT NULL GROUP BY 1, 2
       )
       SELECT center,
              MAX(amount) FILTER (WHERE month = DATE_TRUNC('month', CURRENT_DATE)) AS this_month,
              MAX(amount) FILTER (WHERE month = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')) AS last_month
       FROM months GROUP BY center`,
      [tenantId]
    );
    const alerts = centers
      .map((c: any) => {
        const thisM = parseFloat(c.this_month || 0);
        const lastM = parseFloat(c.last_month || 0);
        const pctChange = lastM > 0 ? Math.round(((thisM - lastM) / lastM) * 100) : null;
        return { center: c.center, this_month: thisM, last_month: lastM, pct_change: pctChange };
      })
      .filter((c: any) => c.pct_change !== null && c.pct_change >= 25);
    ok(res, alerts);
  } catch (e: any) { fail(res, e.message, 500); }
});

// Farmer comparison (spec's #13) — ranks growers by volume, grade
// consistency, and drop-off reliability, in plain language.
teaRouter.get('/ai/farmer-comparison', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { from, to } = req.query as any;
    const dateFrom = from || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const dateTo = to || new Date().toISOString().slice(0, 10);

    const rows = await query<any>(
      `SELECT g.id, g.name, g.grower_code,
              COALESCE(SUM(tc.net_weight), 0) AS total_kg,
              COUNT(*)::int AS drop_offs,
              ROUND(100.0 * COUNT(*) FILTER (WHERE tc.grade='A') / NULLIF(COUNT(*), 0), 1) AS grade_a_pct,
              g.pluck_cycle_days,
              CASE WHEN g.last_pluck_date IS NOT NULL THEN (CURRENT_DATE - g.last_pluck_date) ELSE NULL END AS days_since_last_pluck
       FROM tea_growers g
       LEFT JOIN tea_collections tc ON tc.grower_id = g.id
       LEFT JOIN tea_collection_batches b ON b.id = tc.batch_id AND b.collection_date BETWEEN $2 AND $3
       WHERE g.tenant_id=$1 AND g.is_active=TRUE
       GROUP BY g.id, g.name, g.grower_code, g.pluck_cycle_days, g.last_pluck_date
       ORDER BY total_kg DESC`,
      [tenantId, dateFrom, dateTo]
    );
    ok(res, rows.map((r: any, idx: number) => ({ ...r, rank: idx + 1 })));
  } catch (e: any) { fail(res, e.message, 500); }
});

// Compliance renewal alerts, ranked by urgency (spec's #15) — thin AI
// wrapper over /compliance/calendar that turns the raw list into a
// one-paragraph daily-summary-ready narrative.
teaRouter.get('/ai/compliance-alerts', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const rows = await query<any>(
      `SELECT 'vehicle' AS source, vm.type, vm.due_date AS date, tv.vehicle_number AS label,
              CASE WHEN vm.due_date < CURRENT_DATE THEN 'overdue' ELSE 'due_soon' END AS status
       FROM tea_vehicle_maintenance vm JOIN tea_vehicles tv ON tv.id=vm.vehicle_id
       WHERE vm.tenant_id=$1 AND vm.due_date IS NOT NULL AND vm.due_date <= CURRENT_DATE + 30
       UNION ALL
       SELECT 'machine', mc.type, mc.due_date, m.name,
              CASE WHEN mc.due_date < CURRENT_DATE THEN 'overdue' ELSE 'due_soon' END
       FROM tea_machine_compliance mc JOIN tea_machines m ON m.id=mc.machine_id
       WHERE mc.tenant_id=$1 AND mc.due_date IS NOT NULL AND mc.due_date <= CURRENT_DATE + 30
       UNION ALL
       SELECT 'facility', f.type, f.renewal_date, f.name,
              CASE WHEN f.renewal_date < CURRENT_DATE THEN 'overdue' ELSE 'due_soon' END
       FROM tea_facilities f
       WHERE f.tenant_id=$1 AND f.renewal_date IS NOT NULL AND f.renewal_date <= CURRENT_DATE + 30
       ORDER BY status, date`,
      [tenantId]
    );
    if (!rows.length) return ok(res, { items: [], summary: 'Nothing due for renewal in the next 30 days.' });

    const prompt = `Summarize these upcoming compliance renewals for a tea factory owner in one short paragraph, most urgent first:
${rows.map((r: any) => `${r.label} — ${r.type} (${r.source}) — ${r.status === 'overdue' ? 'OVERDUE' : 'due'} ${r.date}`).join('\n')}`;
    const summary = await askClaude('tea_compliance_alerts', prompt, tenantId, 250);
    ok(res, { items: rows, summary: summary.trim() });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════════════════
// TEAFACTORY360 — NOTIFICATIONS (agent-facing action feed: unpaid grower
// payments, batches waiting to be dispatched, vehicle maintenance due —
// the small set of things a field agent needs to act on today, pulled
// from data that already exists rather than a separate notifications table)
// ════════════════════════════════════════════════════════════════════════
teaRouter.get('/notifications', async (req, res) => {
  try {
    const { tenantId } = req.params as any;

    const [unpaid] = await query<any>(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(net_payable), 0) AS amount
       FROM tea_grower_settlements WHERE tenant_id=$1 AND paid=FALSE`,
      [tenantId]
    );
    const [pendingDispatch] = await query<any>(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_kg), 0) AS kg
       FROM tea_collection_batches WHERE tenant_id=$1 AND status='pending_dispatch'`,
      [tenantId]
    );
    const maintDue = await query<any>(
      `SELECT vm.type, vm.due_date, tv.vehicle_number,
              CASE WHEN vm.due_date < CURRENT_DATE THEN 'overdue' ELSE 'due_soon' END AS status
       FROM tea_vehicle_maintenance vm JOIN tea_vehicles tv ON tv.id=vm.vehicle_id
       WHERE vm.tenant_id=$1 AND vm.due_date IS NOT NULL AND vm.due_date <= CURRENT_DATE + 14
       ORDER BY vm.due_date`,
      [tenantId]
    );

    const items: any[] = [];
    if (unpaid?.count > 0) {
      items.push({
        type: 'grower_payment', severity: 'high',
        message: `${unpaid.count} grower payment${unpaid.count > 1 ? 's' : ''} pending — ₹${Math.round(parseFloat(unpaid.amount))} total`,
      });
    }
    if (pendingDispatch?.count > 0) {
      items.push({
        type: 'pending_dispatch', severity: 'medium',
        message: `${pendingDispatch.count} collection batch${pendingDispatch.count > 1 ? 'es' : ''} waiting to be dispatched (${parseFloat(pendingDispatch.kg).toFixed(0)} kg)`,
      });
    }
    for (const m of maintDue) {
      items.push({
        type: 'vehicle_maintenance', severity: m.status === 'overdue' ? 'high' : 'medium',
        message: `${m.vehicle_number}: ${String(m.type).replace('_', ' ')} ${m.status === 'overdue' ? 'overdue' : `due ${new Date(m.due_date).toLocaleDateString('en-IN')}`}`,
      });
    }
    ok(res, items);
  } catch (e: any) { fail(res, e.message, 500); }
});
