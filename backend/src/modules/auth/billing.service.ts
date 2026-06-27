// ============================================================
// BILLING + AI + ALERT + MASTER MODULE (FIXED)
// ============================================================

import { Router } from 'express';
import { query, queryOne, withTransaction } from '../../config/db';
import { commandBus, ICommand, ICommandHandler } from '../../cqrs/commandBus';
import { queryBus, IQuery, IQueryHandler } from '../../cqrs/queryBus';
import { authMiddleware } from '../auth/auth.service';
import { requireRole, requireMinRole } from '../../core/guards/roleGuard';
import Anthropic from '@anthropic-ai/sdk';

// ─────────────────────────────────────────────────────────────
// COMMON RESPONSE
// ─────────────────────────────────────────────────────────────
function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg });
}

// ============================================================
// 🟢 BILLING MODULE
// ============================================================

// ---------------- COMMANDS ----------------

interface GenerateInvoicesCommand extends ICommand {
  type: 'billing.generateInvoices';
  month: string;
  dryRun?: boolean;
}

class GenerateInvoicesCommandHandler
  implements ICommandHandler<GenerateInvoicesCommand, any>
{
  async execute(cmd: GenerateInvoicesCommand) {
    const periodStart = new Date(cmd.month);
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    const tenants = await query<any>(`
      SELECT t.*, ts.amount_inr, ts.billing_cycle, ts.id as sub_id
      FROM tenants t
      JOIN tenant_subscriptions ts ON ts.tenant_id=t.id AND ts.is_current=TRUE
      WHERE t.billing_status IN ('active','past_due') AND ts.amount_inr > 0
    `);

    const invoices: any[] = [];

    for (const t of tenants) {
      const exists = await queryOne(
        `SELECT id FROM invoices WHERE tenant_id=$1 AND billing_period_from=$2`,
        [t.id, periodStart]
      );

      if (exists) {
        invoices.push({ ...exists, skipped: true });
        continue;
      }

      const subtotal = Number(t.amount_inr);
      const gstAmt = subtotal * 0.18;
      const total = subtotal + gstAmt;

      if (!cmd.dryRun) {
        const [inv] = await query<any>(
          `INSERT INTO invoices (tenant_id,subscription_id,plan_type,billing_period_from,billing_period_to,subtotal_inr,gst_rate,gst_amount_inr,total_inr,status,issued_at)
           VALUES ($1,$2,$3,$4,$5,$6,18,$7,$8,'issued',NOW())
           RETURNING *`,
          [t.id, t.sub_id, t.plan_type, periodStart, periodEnd, subtotal, gstAmt, total]
        );
        invoices.push(inv);
      } else {
        invoices.push({ tenant_id: t.id, total_inr: total, dry_run: true });
      }
    }

    return { invoices };
  }
}

// ---------------- QUERY ----------------

interface ListInvoicesQuery extends IQuery {
  type: 'billing.invoices';
  tenantId?: string;
  page: number;
  limit: number;
}

class ListInvoicesQueryHandler
  implements IQueryHandler<ListInvoicesQuery, any>
{
  async execute(q: ListInvoicesQuery) {
    const offset = (q.page - 1) * q.limit;

    const items = await query<any>(
      `SELECT * FROM invoices
       WHERE ($1::uuid IS NULL OR tenant_id=$1)
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [q.tenantId || null, q.limit, offset]
    );

    return { items };
  }
}

// REGISTER
commandBus.register('billing.generateInvoices', new GenerateInvoicesCommandHandler());
queryBus.register('billing.invoices', new ListInvoicesQueryHandler());

// ---------------- ROUTER ----------------

export const billingRouter = Router();
billingRouter.use(authMiddleware);

billingRouter.get('/invoices', async (req, res) => {
  try {
    const user = (req as any).user;

    const result = await queryBus.execute({
      type: 'billing.invoices',
      tenantId: user.tenantId,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
    } as ListInvoicesQuery);

    ok(res, result);
  } catch (e: any) {
    fail(res, e.message);
  }
});

// ============================================================
// 🟢 AI MODULE (FIXED)
// ============================================================

interface GenerateReportCommand extends ICommand {
  type: 'ai.generateReport';
  storeId: string;
  tenantId: string;
  industryId: string;
  email: string;
}

class GenerateReportCommandHandler
  implements ICommandHandler<GenerateReportCommand, any>
{
  private anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
  });

  async execute(cmd: GenerateReportCommand) {
    const cleanEmail = cmd.email?.toLowerCase();

    const items = await query<any>(
      `SELECT id,name,current_stock FROM items WHERE store_id=$1 LIMIT 5`,
      [cmd.storeId]
    );

    const prompt = `Forecast demand: ${JSON.stringify(items)}`;

    const msg = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    return {
      email: cleanEmail,
      response: (msg.content[0] as any).text,
    };
  }
}

commandBus.register('ai.generateReport', new GenerateReportCommandHandler());

// ============================================================
// 🟢 DASHBOARD (FIXED)
// ============================================================
