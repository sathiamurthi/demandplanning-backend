"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.accountingRouter = void 0;
exports.postJournalEntry = postJournalEntry;
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const roleGuard_1 = require("../../core/guards/roleGuard");
const auth_service_1 = require("./auth.service");
function ok(res, data, status = 200) {
    res.status(status).json({ success: true, data });
}
function fail(res, message, status = 400) {
    res.status(status).json({ success: false, error: message });
}
exports.accountingRouter = (0, express_1.Router)({ mergeParams: true });
exports.accountingRouter.use(auth_service_1.authMiddleware);
exports.accountingRouter.use(auth_service_1.tenantContextMiddleware);
// ==========================================
// CHART OF ACCOUNTS (COA)
// ==========================================
// Seed default accounts (IndAS)
exports.accountingRouter.post('/coa/seed', (0, roleGuard_1.requireMinRole)('owner'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const storeId = req.params.storeId;
        const existing = await (0, db_1.query)('SELECT id FROM chart_of_accounts WHERE tenant_id = $1 LIMIT 1', [tenantId]);
        if (existing.length > 0)
            return fail(res, 'Chart of accounts already seeded for this tenant.');
        const defaultAccounts = [
            { name: 'Cash', type: 'Asset' },
            { name: 'Bank Account', type: 'Asset' },
            { name: 'Accounts Receivable', type: 'Asset' },
            { name: 'Inventory', type: 'Asset' },
            { name: 'Accounts Payable', type: 'Liability' },
            { name: 'GST Payable', type: 'Liability' },
            { name: 'Owner Equity', type: 'Equity' },
            { name: 'Sales Revenue', type: 'Revenue' },
            { name: 'Cost of Goods Sold', type: 'Expense' },
            { name: 'Rent Expense', type: 'Expense' },
            { name: 'Salary Expense', type: 'Expense' },
        ];
        await (0, db_1.withTransaction)(async (client) => {
            for (const acc of defaultAccounts) {
                await client.query('INSERT INTO chart_of_accounts (tenant_id, store_id, name, account_type) VALUES ($1, $2, $3, $4)', [tenantId, storeId, acc.name, acc.type]);
            }
        });
        ok(res, { message: 'Chart of accounts seeded successfully' });
    }
    catch (e) {
        fail(res, e.message);
    }
});
// List all accounts
exports.accountingRouter.get('/coa', async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const accounts = await (0, db_1.query)('SELECT * FROM chart_of_accounts WHERE tenant_id = $1 ORDER BY account_type, name', [tenantId]);
        ok(res, accounts);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// Create new account
exports.accountingRouter.post('/coa', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const storeId = req.params.storeId;
        const { name, account_type, parent_id, account_code } = req.body;
        if (!name || !account_type)
            return fail(res, 'Name and account_type are required');
        const result = await (0, db_1.queryOne)('INSERT INTO chart_of_accounts (tenant_id, store_id, name, account_type, parent_id, account_code) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [tenantId, storeId, name, account_type, parent_id || null, account_code || null]);
        ok(res, result);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// ==========================================
// JOURNAL ENTRIES
// ==========================================
const JournalEntrySchema = zod_1.z.object({
    voucher_no: zod_1.z.string().optional(),
    voucher_type: zod_1.z.enum(['Journal', 'Receipt', 'Payment', 'Contra', 'Sales', 'Purchase']),
    entry_date: zod_1.z.string(), // YYYY-MM-DD
    narrative: zod_1.z.string().optional(),
    lines: zod_1.z.array(zod_1.z.object({
        account_id: zod_1.z.string().uuid(),
        debit: zod_1.z.number().default(0),
        credit: zod_1.z.number().default(0),
        narrative: zod_1.z.string().optional()
    })).min(2, "At least two lines are required for a double entry")
});
async function postJournalEntry(client, data) {
    // Create Header
    const headerRes = await client.query(`INSERT INTO journal_entries (tenant_id, store_id, voucher_no, voucher_type, entry_date, narrative, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [data.tenantId, data.storeId, data.voucher_no || `JV-${Date.now()}`, data.voucher_type, data.entry_date, data.narrative, data.userId]);
    const header = headerRes.rows[0];
    // Insert Lines and Update Balances
    for (const line of data.lines) {
        await client.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit, narrative)
       VALUES ($1, $2, $3, $4, $5)`, [header.id, line.account_id, line.debit, line.credit, line.narrative]);
        const accRes = await client.query('SELECT account_type FROM chart_of_accounts WHERE id=$1', [line.account_id]);
        if (accRes.rows.length) {
            const type = accRes.rows[0].account_type;
            let netChange = 0;
            if (['Asset', 'Expense'].includes(type)) {
                netChange = line.debit - line.credit;
            }
            else {
                netChange = line.credit - line.debit;
            }
            await client.query('UPDATE chart_of_accounts SET current_balance = current_balance + $1 WHERE id=$2', [netChange, line.account_id]);
        }
    }
    return header;
}
exports.accountingRouter.post('/journal', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const parsed = JournalEntrySchema.parse(req.body);
        const tenantId = req.user.tenantId;
        const storeId = req.params.storeId;
        const userId = req.user.sub;
        const totalDebit = parsed.lines.reduce((sum, line) => sum + line.debit, 0);
        const totalCredit = parsed.lines.reduce((sum, line) => sum + line.credit, 0);
        if (Math.abs(totalDebit - totalCredit) > 0.01) {
            return fail(res, `Unbalanced Journal Entry. Total Debit: ${totalDebit}, Total Credit: ${totalCredit}`);
        }
        const entry = await (0, db_1.withTransaction)(async (client) => {
            return await postJournalEntry(client, {
                tenantId, storeId, userId,
                voucher_no: parsed.voucher_no,
                voucher_type: parsed.voucher_type,
                entry_date: parsed.entry_date,
                narrative: parsed.narrative,
                lines: parsed.lines
            });
        });
        ok(res, entry);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// Get Journal Entries
exports.accountingRouter.get('/journal', async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const storeId = req.params.storeId;
        const entries = await (0, db_1.query)(`SELECT j.*, 
        (SELECT json_agg(json_build_object('account_name', c.name, 'debit', l.debit, 'credit', l.credit))
         FROM journal_lines l JOIN chart_of_accounts c ON c.id = l.account_id 
         WHERE l.entry_id = j.id) as lines
       FROM journal_entries j
       WHERE j.tenant_id = $1 AND j.store_id = $2
       ORDER BY j.entry_date DESC, j.created_at DESC
       LIMIT 100`, [tenantId, storeId]);
        ok(res, entries);
    }
    catch (e) {
        fail(res, e.message);
    }
});
