"use strict";
// ============================================================
// SUPPLIERS ROUTER
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.suppliersRouter = void 0;
const express_1 = require("express");
const db_1 = require("../../config/db");
const auth_service_1 = require("../auth/auth.service");
const roleGuard_1 = require("../../core/guards/roleGuard");
const router = (0, express_1.Router)({ mergeParams: true });
router.use(auth_service_1.authMiddleware);
// helpers
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, msg, status = 400) => res.status(status).json({ success: false, error: msg });
// ============================================================
// GET ALL SUPPLIERS
// ============================================================
router.get('/', async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const suppliers = await (0, db_1.query)(`SELECT * FROM suppliers 
       WHERE tenant_id=$1 AND is_active=TRUE 
       ORDER BY name`, [tenantId]);
        ok(res, suppliers);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// ============================================================
// GET SUPPLIER BY ID
// ============================================================
router.get('/:supplierId', async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const supplier = await (0, db_1.queryOne)(`SELECT * FROM suppliers 
       WHERE id=$1 AND tenant_id=$2`, [req.params.supplierId, tenantId]);
        if (!supplier)
            return fail(res, 'Supplier not found', 404);
        ok(res, supplier);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// ============================================================
// CREATE SUPPLIER
// ============================================================
router.post('/', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const b = req.body;
        const [supplier] = await (0, db_1.query)(`INSERT INTO suppliers (
        tenant_id, name, contact_name, email, phone,
        address, gst_number, payment_terms_days,
        lead_time_days, rating, notes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *`, [
            tenantId,
            b.name,
            b.contactName || null,
            b.email || null,
            b.phone || null,
            b.address || null,
            b.gstNumber || null,
            b.paymentTermsDays || 30,
            b.leadTimeDays || 5,
            b.rating || null,
            b.notes || null,
        ]);
        ok(res, supplier, 201);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// ============================================================
// UPDATE SUPPLIER
// ============================================================
router.put('/:supplierId', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const b = req.body;
        const [supplier] = await (0, db_1.query)(`UPDATE suppliers SET
        name = COALESCE($1, name),
        contact_name = COALESCE($2, contact_name),
        email = COALESCE($3, email),
        phone = COALESCE($4, phone),
        address = COALESCE($5, address),
        gst_number = COALESCE($6, gst_number),
        payment_terms_days = COALESCE($7, payment_terms_days),
        lead_time_days = COALESCE($8, lead_time_days),
        rating = COALESCE($9, rating),
        notes = COALESCE($10, notes),
        updated_at = NOW()
      WHERE id=$11 AND tenant_id=$12
      RETURNING *`, [
            b.name || null,
            b.contactName || null,
            b.email || null,
            b.phone || null,
            b.address || null,
            b.gstNumber || null,
            b.paymentTermsDays || null,
            b.leadTimeDays || null,
            b.rating || null,
            b.notes || null,
            req.params.supplierId,
            tenantId,
        ]);
        if (!supplier)
            return fail(res, 'Supplier not found', 404);
        ok(res, supplier);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// ============================================================
// DELETE (SOFT DELETE)
// ============================================================
router.delete('/:supplierId', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        await (0, db_1.query)(`UPDATE suppliers 
       SET is_active=FALSE, updated_at=NOW()
       WHERE id=$1 AND tenant_id=$2`, [req.params.supplierId, tenantId]);
        ok(res, { message: 'Supplier deactivated' });
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.suppliersRouter = router;
