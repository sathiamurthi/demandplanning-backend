"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unitsRouter = void 0;
const express_1 = require("express");
const db_1 = require("../../config/db");
const router = (0, express_1.Router)();
const ok = (res, data) => res.json({ success: true, data });
const fail = (res, msg) => res.status(400).json({ success: false, error: msg });
// ============================================================
// GET ALL UNITS
// ============================================================
router.get('/', async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        const units = await (0, db_1.query)("SELECT * FROM unit_types WHERE tenant_id IS NULL OR tenant_id = $1 ORDER BY name", [tenantId]);
        ok(res, units);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// ============================================================
// CREATE UNIT
// ============================================================
router.post('/', async (req, res) => {
    try {
        const { name, symbol, category, is_active } = req.body;
        const tenantId = req.user?.tenantId;
        const result = await (0, db_1.query)(`INSERT INTO unit_types (name, symbol, category, is_active, tenant_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`, [name, symbol, category || 'count', is_active ?? true, tenantId]);
        ok(res, result[0]);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// ============================================================
// UPDATE UNIT
// ============================================================
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, symbol, category, is_active } = req.body;
        const tenantId = req.user?.tenantId;
        const result = await (0, db_1.query)(`UPDATE unit_types 
       SET name=$1, symbol=$2, category=$3, is_active=$4, updated_at=NOW()
       WHERE id=$5 AND (tenant_id IS NULL OR tenant_id = $6) RETURNING *`, [name, symbol, category, is_active, id, tenantId]);
        if (!result.length)
            throw new Error("Not found or no permission");
        ok(res, result[0]);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// ============================================================
// DELETE UNIT
// ============================================================
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const tenantId = req.user?.tenantId;
        // Don't allow deleting global units
        const result = await (0, db_1.query)(`DELETE FROM unit_types WHERE id=$1 AND tenant_id=$2 RETURNING *`, [id, tenantId]);
        if (!result.length)
            throw new Error("Not found or cannot delete global unit");
        ok(res, { deleted: true });
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.unitsRouter = router;
