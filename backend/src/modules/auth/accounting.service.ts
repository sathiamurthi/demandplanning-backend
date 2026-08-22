import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../config/db';
import { requireMinRole } from '../../core/guards/roleGuard';
import { authMiddleware, tenantContextMiddleware } from './auth.service';

function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data });
}
function fail(res: any, message: string, status = 400) {
  res.status(status).json({ success: false, error: message });
}

export const accountingRouter = Router({ mergeParams: true });
accountingRouter.use(authMiddleware);
accountingRouter.use(tenantContextMiddleware);

// ==========================================
// CHART OF ACCOUNTS (COA)
// ==========================================

// Seed default accounts (IndAS)
accountingRouter.post('/coa/seed', requireMinRole('owner'), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const storeId = (req.params as any).storeId;
    
    const existing = await query('SELECT id FROM chart_of_accounts WHERE tenant_id = $1 LIMIT 1', [tenantId]);
    if (existing.length > 0) return fail(res, 'Chart of accounts already seeded for this tenant.');

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

    await withTransaction(async (client) => {
      for (const acc of defaultAccounts) {
        await client.query(
          'INSERT INTO chart_of_accounts (tenant_id, store_id, name, account_type) VALUES ($1, $2, $3, $4)',
          [tenantId, storeId, acc.name, acc.type]
        );
      }
    });

    ok(res, { message: 'Chart of accounts seeded successfully' });
  } catch (e: any) { fail(res, e.message); }
});

// List all accounts
accountingRouter.get('/coa', async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const accounts = await query('SELECT * FROM chart_of_accounts WHERE tenant_id = $1 ORDER BY account_type, name', [tenantId]);
    ok(res, accounts);
  } catch (e: any) { fail(res, e.message); }
});

// Create new account
accountingRouter.post('/coa', requireMinRole('manager'), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const storeId = (req.params as any).storeId;
    const { name, account_type, parent_id, account_code } = req.body;
    
    if (!name || !account_type) return fail(res, 'Name and account_type are required');

    const result = await queryOne(
      'INSERT INTO chart_of_accounts (tenant_id, store_id, name, account_type, parent_id, account_code) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [tenantId, storeId, name, account_type, parent_id || null, account_code || null]
    );
    ok(res, result);
  } catch (e: any) { fail(res, e.message); }
});

// ==========================================
// JOURNAL ENTRIES
// ==========================================

const JournalEntrySchema = z.object({
  voucher_no: z.string().optional(),
  voucher_type: z.enum(['Journal', 'Receipt', 'Payment', 'Contra', 'Sales', 'Purchase']),
  entry_date: z.string(), // YYYY-MM-DD
  narrative: z.string().optional(),
  lines: z.array(z.object({
    account_id: z.string().uuid(),
    debit: z.number().default(0),
    credit: z.number().default(0),
    narrative: z.string().optional()
  })).min(2, "At least two lines are required for a double entry")
});

export async function postJournalEntry(client: any, data: any) {
  // Create Header
  const headerRes = await client.query(
    `INSERT INTO journal_entries (tenant_id, store_id, voucher_no, voucher_type, entry_date, narrative, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [data.tenantId, data.storeId, data.voucher_no || `JV-${Date.now()}`, data.voucher_type, data.entry_date, data.narrative, data.userId]
  );
  const header = headerRes.rows[0];

  // Insert Lines and Update Balances
  for (const line of data.lines) {
    await client.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit, narrative)
       VALUES ($1, $2, $3, $4, $5)`,
      [header.id, line.account_id, line.debit, line.credit, line.narrative]
    );

    const accRes = await client.query('SELECT account_type FROM chart_of_accounts WHERE id=$1', [line.account_id]);
    if (accRes.rows.length) {
      const type = accRes.rows[0].account_type;
      let netChange = 0;
      if (['Asset', 'Expense'].includes(type)) {
        netChange = line.debit - line.credit;
      } else {
        netChange = line.credit - line.debit;
      }
      await client.query('UPDATE chart_of_accounts SET current_balance = current_balance + $1 WHERE id=$2', [netChange, line.account_id]);
    }
  }

  return header;
}

accountingRouter.post('/journal', requireMinRole('manager'), async (req, res) => {
  try {
    const parsed = JournalEntrySchema.parse(req.body);
    const tenantId = (req as any).user.tenantId;
    const storeId = (req.params as any).storeId;
    const userId = (req as any).user.sub;

    const totalDebit = parsed.lines.reduce((sum, line) => sum + line.debit, 0);
    const totalCredit = parsed.lines.reduce((sum, line) => sum + line.credit, 0);

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return fail(res, `Unbalanced Journal Entry. Total Debit: ${totalDebit}, Total Credit: ${totalCredit}`);
    }

    const entry = await withTransaction(async (client) => {
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
  } catch (e: any) { fail(res, e.message); }
});

// Get Journal Entries
accountingRouter.get('/journal', async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const storeId = (req.params as any).storeId;
    const entries = await query(
      `SELECT j.*, 
        (SELECT json_agg(json_build_object('account_name', c.name, 'debit', l.debit, 'credit', l.credit))
         FROM journal_lines l JOIN chart_of_accounts c ON c.id = l.account_id 
         WHERE l.entry_id = j.id) as lines
       FROM journal_entries j
       WHERE j.tenant_id = $1 AND j.store_id = $2
       ORDER BY j.entry_date DESC, j.created_at DESC
       LIMIT 100`,
      [tenantId, storeId]
    );
    ok(res, entries);
  } catch (e: any) { fail(res, e.message); }
});
