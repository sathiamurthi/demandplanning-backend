// ============================================================
// COUPONS MODULE — Owner manages, Superadmin views all
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../config/db';
import { authMiddleware } from './auth.service';
import { requireMinRole } from '../../core/guards/roleGuard';

function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}

// ── Schemas ──────────────────────────────────────────────────
const CreateCouponSchema = z.object({
  code:            z.string().min(3).max(30).toUpperCase().optional(),
  description:     z.string().optional(),
  discount_type:   z.enum(['percentage', 'fixed']),
  discount_value:  z.number().positive(),
  min_order_value: z.number().min(0).optional(),
  max_discount:    z.number().positive().optional(),
  usage_limit:     z.number().int().positive().optional(),
  valid_from:      z.string().optional(),
  valid_to:        z.string().optional(),
  is_active:       z.boolean().optional(),
  store_id:        z.string().uuid().optional().nullable(),
});

const UpdateCouponSchema = CreateCouponSchema.partial();

// ── Tenant Coupon Router ─────────────────────────────────────
export const couponsRouter = Router({ mergeParams: true });
couponsRouter.use(authMiddleware);

/** GET /v1/tenants/:tenantId/coupons — list all coupons for this tenant */
couponsRouter.get('/', requireMinRole('manager'), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const rows = await query<any>(
      `SELECT c.*, s.name as store_name,
              (SELECT COUNT(*) FROM coupon_usages cu WHERE cu.coupon_id = c.id)::int as used_count
       FROM coupons c LEFT JOIN stores s ON s.id = c.store_id
       WHERE c.tenant_id = $1 ORDER BY c.created_at DESC`,
      [tenantId]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message); }
});

/** POST /v1/tenants/:tenantId/coupons — create coupon */
couponsRouter.post('/', requireMinRole('owner'), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const bodyRaw = req.body;
    // Parse with schema allowing optional code
    const body = CreateCouponSchema.parse(bodyRaw);
    const user = (req as any).user;

    // Auto-generate coupon code if not provided
    let couponCode = body.code;
    let prefix = '';
    if (!couponCode) {
      // If store_id provided, fetch store name
      if (body.store_id) {
        const store = await queryOne<any>('SELECT name FROM stores WHERE id=$1', [body.store_id]);
        if (store && store.name) {
          prefix = store.name.replace(/\s+/g, '').substring(0, 3).toUpperCase();
        }
      }
      const randomPart = Math.random().toString(36).substring(2, 7).toUpperCase();
      couponCode = `${prefix}${randomPart}`;
    }

    // Ensure uniqueness within tenant (loop if collision)
    let existing = await queryOne<any>('SELECT id FROM coupons WHERE tenant_id=$1 AND code=$2', [tenantId, couponCode]);
    while (existing) {
      const randomPart = Math.random().toString(36).substring(2, 7).toUpperCase();
      couponCode = `${prefix}${randomPart}`;
      existing = await queryOne<any>('SELECT id FROM coupons WHERE tenant_id=$1 AND code=$2', [tenantId, couponCode]);
    }

    const [row] = await query<any>(
      `INSERT INTO coupons (tenant_id, store_id, code, description, discount_type, discount_value,
        min_order_value, max_discount, usage_limit, valid_from, valid_to, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [tenantId, body.store_id || null, couponCode, body.description || null,
       body.discount_type, body.discount_value,
       body.min_order_value ?? 0, body.max_discount ?? null,
       body.usage_limit ?? null, body.valid_from ?? null, body.valid_to ?? null,
       body.is_active ?? true, user.sub]
    );
    ok(res, row, 201);
  } catch (e: any) { fail(res, e.message); }
});

/** PATCH /v1/tenants/:tenantId/coupons/:id — update */
couponsRouter.patch('/:id', requireMinRole('owner'), async (req, res) => {
  try {
    const { tenantId, id } = req.params;
    const body = UpdateCouponSchema.parse(req.body);
    const fields = Object.keys(body);
    if (!fields.length) { fail(res, 'No fields to update'); return; }
    const setClauses = fields.map((f, i) => `${f}=$${i + 2}`).join(', ');
    const values = fields.map(f => (body as any)[f]);
    const [row] = await query<any>(
      `UPDATE coupons SET ${setClauses}, updated_at=NOW() WHERE id=$1 AND tenant_id=$${fields.length + 2} RETURNING *`,
      [id, ...values, tenantId]
    );
    if (!row) { fail(res, 'Coupon not found', 404); return; }
    ok(res, row);
  } catch (e: any) { fail(res, e.message); }
});

/** DELETE /v1/tenants/:tenantId/coupons/:id — deactivate */
couponsRouter.delete('/:id', requireMinRole('owner'), async (req, res) => {
  try {
    const { tenantId, id } = req.params;
    await query('UPDATE coupons SET is_active=FALSE, updated_at=NOW() WHERE id=$1 AND tenant_id=$2', [id, tenantId]);
    ok(res, { message: 'Coupon deactivated' });
  } catch (e: any) { fail(res, e.message); }
});

/** POST /v1/tenants/:tenantId/coupons/validate — validate a coupon code */
couponsRouter.post('/validate', async (req, res) => {
  try {
    const { tenantId } = req.params as any;
    const { code, orderAmount, storeId } = req.body;
    if (!code) { fail(res, 'Coupon code required'); return; }

    const coupon = await queryOne<any>(
      `SELECT c.*, (SELECT COUNT(*) FROM coupon_usages cu WHERE cu.coupon_id = c.id)::int as used_count
       FROM coupons c WHERE c.tenant_id=$1 AND UPPER(c.code)=UPPER($2) AND c.is_active=TRUE`,
      [tenantId, code]
    );

    if (!coupon) { fail(res, 'Invalid or expired coupon code', 404); return; }

    // Date validity
    const now = new Date();
    if (coupon.valid_from && new Date(coupon.valid_from) > now) {
      fail(res, `Coupon is not yet active (starts ${coupon.valid_from.toISOString?.()?.slice(0,10) ?? coupon.valid_from})`); return;
    }
    if (coupon.valid_to && new Date(coupon.valid_to) < now) {
      fail(res, 'Coupon has expired'); return;
    }

    // Usage limit
    if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) {
      fail(res, 'Coupon usage limit reached'); return;
    }

    // Min order value
    const order = parseFloat(orderAmount) || 0;
    if (coupon.min_order_value && order < parseFloat(coupon.min_order_value)) {
      fail(res, `Minimum order value ₹${coupon.min_order_value} required`); return;
    }

    // Store restriction
    if (coupon.store_id && storeId && coupon.store_id !== storeId) {
      fail(res, 'Coupon is not valid for this store'); return;
    }

    // Compute discount
    let discountAmount = 0;
    if (coupon.discount_type === 'percentage') {
      discountAmount = (order * parseFloat(coupon.discount_value)) / 100;
      if (coupon.max_discount) discountAmount = Math.min(discountAmount, parseFloat(coupon.max_discount));
    } else {
      discountAmount = parseFloat(coupon.discount_value);
      if (order > 0) discountAmount = Math.min(discountAmount, order);
    }
    discountAmount = Math.round(discountAmount * 100) / 100;

    ok(res, {
      valid: true,
      coupon: { id: coupon.id, code: coupon.code, description: coupon.description,
                discount_type: coupon.discount_type, discount_value: coupon.discount_value,
                max_discount: coupon.max_discount },
      discountAmount,
      message: coupon.discount_type === 'percentage'
        ? `Coupon applied: ${coupon.discount_value}% off${coupon.max_discount ? ` (max ₹${coupon.max_discount})` : ''}`
        : `Coupon applied: Flat ₹${coupon.discount_value} off`,
    });
  } catch (e: any) { fail(res, e.message); }
});

// ── Superadmin Coupon Router ──────────────────────────────────
export const superadminCouponsRouter = Router();

/** GET /v1/superadmin/coupons — all coupons across all tenants */
superadminCouponsRouter.get('/', async (req, res) => {
  try {
    const { tenantId, search } = req.query;
    const conds: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (tenantId) { conds.push(`c.tenant_id=$${i++}`); vals.push(tenantId); }
    if (search) {
      conds.push(`(UPPER(c.code) LIKE $${i} OR c.description ILIKE $${i})`);
      vals.push(`%${String(search).toUpperCase()}%`); i++;
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = await query<any>(
      `SELECT c.*, t.name as tenant_name, s.name as store_name,
              (SELECT COUNT(*) FROM coupon_usages cu WHERE cu.coupon_id = c.id)::int as used_count
       FROM coupons c
       LEFT JOIN tenants t ON t.id = c.tenant_id
       LEFT JOIN stores  s ON s.id  = c.store_id
       ${where}
       ORDER BY c.created_at DESC LIMIT 200`,
      vals
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message); }
});
