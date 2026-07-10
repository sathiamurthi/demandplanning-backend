"use strict";
// ============================================================
// UNITS ROUTER
// ============================================================
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
router.get('/', async (_req, res) => {
    try {
        const units = await (0, db_1.query)(`SELECT * FROM unit_types WHERE is_active=TRUE ORDER BY name`);
        ok(res, units);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.unitsRouter = router;
