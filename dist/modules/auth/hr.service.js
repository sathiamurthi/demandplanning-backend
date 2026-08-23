"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hrRouter = void 0;
const express_1 = require("express");
const db_1 = require("../../config/db");
const auth_service_1 = require("./auth.service");
exports.hrRouter = (0, express_1.Router)({ mergeParams: true });
exports.hrRouter.use(auth_service_1.authMiddleware);
exports.hrRouter.use(auth_service_1.tenantContextMiddleware);
// ==========================================
// ATTENDANCE
// ==========================================
exports.hrRouter.get('/attendance', async (req, res) => {
    const tenantId = req.tenantId;
    const storeId = req.params.storeId;
    try {
        const result = await db_1.pool.query(`SELECT a.*, u.first_name || ' ' || u.last_name as user_name 
       FROM attendance a 
       JOIN users u ON u.id = a.user_id 
       WHERE a.tenant_id = $1 AND a.store_id = $2 ORDER BY a.date DESC, a.created_at DESC`, [tenantId, storeId]);
        res.json({ success: true, data: result.rows });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
exports.hrRouter.post('/attendance', async (req, res) => {
    const tenantId = req.tenantId;
    const storeId = req.params.storeId;
    const { user_id, date, check_in_time, check_out_time, status, notes } = req.body;
    try {
        const result = await db_1.pool.query(`INSERT INTO attendance (tenant_id, store_id, user_id, date, check_in_time, check_out_time, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [tenantId, storeId, user_id, date, check_in_time || null, check_out_time || null, status || 'Present', notes || '']);
        res.json({ success: true, data: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
exports.hrRouter.put('/attendance/:id', async (req, res) => {
    const tenantId = req.tenantId;
    const { user_id, date, check_in_time, check_out_time, status, notes } = req.body;
    try {
        const result = await db_1.pool.query(`UPDATE attendance 
       SET user_id = COALESCE($1, user_id), date = COALESCE($2, date), 
           check_in_time = $3, check_out_time = $4, status = COALESCE($5, status), notes = COALESCE($6, notes)
       WHERE id = $7 AND tenant_id = $8 RETURNING *`, [user_id, date, check_in_time || null, check_out_time || null, status, notes, req.params.id, tenantId]);
        res.json({ success: true, data: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
exports.hrRouter.delete('/attendance/:id', async (req, res) => {
    const tenantId = req.tenantId;
    try {
        await db_1.pool.query('DELETE FROM attendance WHERE id = $1 AND tenant_id = $2', [req.params.id, tenantId]);
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// ==========================================
// TIMESHEETS
// ==========================================
exports.hrRouter.get('/timesheets', async (req, res) => {
    const tenantId = req.tenantId;
    const storeId = req.params.storeId;
    try {
        const result = await db_1.pool.query(`SELECT t.*, u.first_name || ' ' || u.last_name as user_name 
       FROM timesheets t 
       JOIN users u ON u.id = t.user_id 
       WHERE t.tenant_id = $1 AND t.store_id = $2 ORDER BY t.period_start DESC, t.created_at DESC`, [tenantId, storeId]);
        res.json({ success: true, data: result.rows });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
exports.hrRouter.post('/timesheets', async (req, res) => {
    const tenantId = req.tenantId;
    const storeId = req.params.storeId;
    const { user_id, period_start, period_end, total_hours, status } = req.body;
    try {
        const result = await db_1.pool.query(`INSERT INTO timesheets (tenant_id, store_id, user_id, period_start, period_end, total_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [tenantId, storeId, user_id, period_start, period_end, total_hours || 0, status || 'Draft']);
        res.json({ success: true, data: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
exports.hrRouter.put('/timesheets/:id', async (req, res) => {
    const tenantId = req.tenantId;
    const { user_id, period_start, period_end, total_hours, status } = req.body;
    try {
        const result = await db_1.pool.query(`UPDATE timesheets 
       SET user_id = COALESCE($1, user_id), period_start = COALESCE($2, period_start), 
           period_end = COALESCE($3, period_end), total_hours = COALESCE($4, total_hours), status = COALESCE($5, status)
       WHERE id = $6 AND tenant_id = $7 RETURNING *`, [user_id, period_start, period_end, total_hours, status, req.params.id, tenantId]);
        res.json({ success: true, data: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
exports.hrRouter.delete('/timesheets/:id', async (req, res) => {
    const tenantId = req.tenantId;
    try {
        await db_1.pool.query('DELETE FROM timesheets WHERE id = $1 AND tenant_id = $2', [req.params.id, tenantId]);
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
