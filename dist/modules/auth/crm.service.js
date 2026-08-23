"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.crmRouter = void 0;
const express_1 = require("express");
const db_1 = require("../../config/db");
const auth_service_1 = require("./auth.service");
exports.crmRouter = (0, express_1.Router)({ mergeParams: true });
exports.crmRouter.use(auth_service_1.authMiddleware);
exports.crmRouter.use(auth_service_1.tenantContextMiddleware);
// ==========================================
// LEADS
// ==========================================
// Get all leads
exports.crmRouter.get('/leads', async (req, res) => {
    const tenantId = req.tenantId;
    const storeId = req.params.storeId;
    const { status } = req.query;
    try {
        let query = 'SELECT * FROM leads WHERE tenant_id = $1 AND store_id = $2';
        const params = [tenantId, storeId];
        if (status) {
            params.push(status);
            query += ` AND status = $${params.length}`;
        }
        query += ' ORDER BY created_at DESC';
        const result = await db_1.pool.query(query, params);
        res.json({ success: true, data: result.rows });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// Create lead
exports.crmRouter.post('/leads', async (req, res) => {
    const tenantId = req.tenantId;
    const storeId = req.params.storeId;
    const { customer_name, company_name, phone, email, status, source, value, notes, assigned_to } = req.body;
    const userId = req.user?.userId;
    try {
        const result = await db_1.pool.query(`INSERT INTO leads (tenant_id, store_id, customer_name, company_name, phone, email, status, source, value, notes, assigned_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`, [tenantId, storeId, customer_name, company_name, phone, email, status || 'New', source, value || 0, notes, assigned_to, userId]);
        res.json({ success: true, data: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// Update lead
exports.crmRouter.put('/leads/:id', async (req, res) => {
    const tenantId = req.tenantId;
    const { id } = req.params;
    const { customer_name, company_name, phone, email, status, source, value, notes, assigned_to } = req.body;
    try {
        const result = await db_1.pool.query(`UPDATE leads 
       SET customer_name = COALESCE($1, customer_name),
           company_name = COALESCE($2, company_name),
           phone = COALESCE($3, phone),
           email = COALESCE($4, email),
           status = COALESCE($5, status),
           source = COALESCE($6, source),
           value = COALESCE($7, value),
           notes = COALESCE($8, notes),
           assigned_to = COALESCE($9, assigned_to),
           updated_at = NOW()
       WHERE id = $10 AND tenant_id = $11 RETURNING *`, [customer_name, company_name, phone, email, status, source, value, notes, assigned_to, id, tenantId]);
        if (result.rowCount === 0)
            return res.status(404).json({ success: false, error: 'Lead not found' });
        res.json({ success: true, data: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// Delete lead
exports.crmRouter.delete('/leads/:id', async (req, res) => {
    const tenantId = req.tenantId;
    try {
        const result = await db_1.pool.query('DELETE FROM leads WHERE id = $1 AND tenant_id = $2 RETURNING id', [req.params.id, tenantId]);
        if (result.rowCount === 0)
            return res.status(404).json({ success: false, error: 'Lead not found' });
        res.json({ success: true, data: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// ==========================================
// QUOTATIONS
// ==========================================
exports.crmRouter.get('/quotations', async (req, res) => {
    const tenantId = req.tenantId;
    const storeId = req.params.storeId;
    try {
        const result = await db_1.pool.query('SELECT * FROM quotations WHERE tenant_id = $1 AND store_id = $2 ORDER BY created_at DESC', [tenantId, storeId]);
        res.json({ success: true, data: result.rows });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
exports.crmRouter.post('/quotations', async (req, res) => {
    const tenantId = req.tenantId;
    const storeId = req.params.storeId;
    const userId = req.user?.userId;
    const { lead_id, customer_name, customer_email, customer_phone, issue_date, valid_until, status, notes, terms, items } = req.body;
    const client = await db_1.pool.connect();
    try {
        await client.query('BEGIN');
        const countRes = await client.query('SELECT COUNT(*) FROM quotations WHERE tenant_id = $1', [tenantId]);
        const quoteNum = `QT-${new Date().getFullYear()}-${String(parseInt(countRes.rows[0].count) + 1).padStart(4, '0')}`;
        let subtotal = 0, discount_amount = 0, gst_amount = 0, total_amount = 0;
        for (const item of (items || [])) {
            subtotal += Number(item.qty) * Number(item.unit_price);
            const discount = (Number(item.qty) * Number(item.unit_price) * Number(item.discount_pct || 0)) / 100;
            discount_amount += discount;
            const taxable = (Number(item.qty) * Number(item.unit_price)) - discount;
            gst_amount += (taxable * Number(item.gst_rate || 0)) / 100;
        }
        total_amount = subtotal - discount_amount + gst_amount;
        const quoteRes = await client.query(`INSERT INTO quotations (tenant_id, store_id, lead_id, quote_number, customer_name, customer_email, customer_phone, issue_date, valid_until, subtotal, discount_amount, gst_amount, total_amount, status, notes, terms, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`, [tenantId, storeId, lead_id, quoteNum, customer_name, customer_email, customer_phone, issue_date, valid_until, subtotal, discount_amount, gst_amount, total_amount, status || 'Draft', notes, terms, userId]);
        const quote = quoteRes.rows[0];
        for (const item of (items || [])) {
            const line_total = (Number(item.qty) * Number(item.unit_price)) * (1 - Number(item.discount_pct || 0) / 100) * (1 + Number(item.gst_rate || 0) / 100);
            await client.query(`INSERT INTO quotation_items (quotation_id, item_id, description, qty, unit_price, discount_pct, gst_rate, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [quote.id, item.item_id, item.description, item.qty, item.unit_price, item.discount_pct || 0, item.gst_rate || 0, line_total]);
        }
        await client.query('COMMIT');
        res.json({ success: true, data: quote });
    }
    catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    }
    finally {
        client.release();
    }
});
exports.crmRouter.get('/quotations/:id', async (req, res) => {
    const tenantId = req.tenantId;
    const { id } = req.params;
    try {
        const qRes = await db_1.pool.query('SELECT * FROM quotations WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
        if (qRes.rowCount === 0)
            return res.status(404).json({ success: false, error: 'Quotation not found' });
        const iRes = await db_1.pool.query(`SELECT qi.*, i.name as item_name, i.sku as item_sku 
       FROM quotation_items qi 
       LEFT JOIN items i ON i.id = qi.item_id 
       WHERE qi.quotation_id = $1`, [id]);
        res.json({ success: true, data: { ...qRes.rows[0], items: iRes.rows } });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
