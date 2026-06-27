// ============================================================
// INDUSTRY MODULE — Full CQRS Router
// POST/PUT/GET/DELETE industry configs
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../config/db';
import { commandBus, ICommand, ICommandHandler } from '../../cqrs/commandBus';
import { queryBus, IQuery, IQueryHandler } from '../../cqrs/queryBus';
import { authMiddleware } from '../auth/auth.service';
import { requireRole } from '../../core/guards/roleGuard';

function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}

// ── Commands ─────────────────────────────────────────────────

interface CreateIndustryCommand extends ICommand {
  readonly type: 'industry.create';
  industryId: string;
  displayName: string;
  itemNoun: string;
  defaultUnitSymbol: string;
  domainKeywords: string[];
  offTopicKeywords: string[];
  seasonalSignals: string[];
  promptContext: string;
  lowStockDays: number;
  expiryWarnDays: number;
}

class CreateIndustryCommandHandler implements ICommandHandler<CreateIndustryCommand> {
  async execute(cmd: CreateIndustryCommand) {
    const exists = await queryOne('SELECT id FROM industry_configs WHERE industry_id=$1', [cmd.industryId]);
    if (exists) throw new Error(`Industry "${cmd.industryId}" already exists`);

    const [row] = await query<any>(
      `INSERT INTO industry_configs
         (industry_id, display_name, item_noun, default_unit_symbol,
          domain_keywords, off_topic_keywords, seasonal_signals,
          prompt_context, low_stock_days, expiry_warn_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        cmd.industryId, cmd.displayName, cmd.itemNoun, cmd.defaultUnitSymbol,
        cmd.domainKeywords, cmd.offTopicKeywords, cmd.seasonalSignals,
        cmd.promptContext, cmd.lowStockDays, cmd.expiryWarnDays,
      ]
    );
    return row;
  }
}

interface UpdateIndustryCommand extends ICommand {
  readonly type: 'industry.update';
  industryId: string;
  displayName?: string;
  itemNoun?: string;
  defaultUnitSymbol?: string;
  domainKeywords?: string[];
  offTopicKeywords?: string[];
  seasonalSignals?: string[];
  promptContext?: string;
  lowStockDays?: number;
  expiryWarnDays?: number;
  isActive?: boolean;
}

class UpdateIndustryCommandHandler implements ICommandHandler<UpdateIndustryCommand> {
  async execute(cmd: UpdateIndustryCommand) {
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (cmd.displayName !== undefined)      { sets.push(`display_name=$${i++}`);       vals.push(cmd.displayName); }
    if (cmd.itemNoun !== undefined)         { sets.push(`item_noun=$${i++}`);           vals.push(cmd.itemNoun); }
    if (cmd.defaultUnitSymbol !== undefined){ sets.push(`default_unit_symbol=$${i++}`); vals.push(cmd.defaultUnitSymbol); }
    if (cmd.domainKeywords !== undefined)   { sets.push(`domain_keywords=$${i++}`);    vals.push(cmd.domainKeywords); }
    if (cmd.offTopicKeywords !== undefined) { sets.push(`off_topic_keywords=$${i++}`); vals.push(cmd.offTopicKeywords); }
    if (cmd.seasonalSignals !== undefined)  { sets.push(`seasonal_signals=$${i++}`);   vals.push(cmd.seasonalSignals); }
    if (cmd.promptContext !== undefined)    { sets.push(`prompt_context=$${i++}`);      vals.push(cmd.promptContext); }
    if (cmd.lowStockDays !== undefined)     { sets.push(`low_stock_days=$${i++}`);      vals.push(cmd.lowStockDays); }
    if (cmd.expiryWarnDays !== undefined)   { sets.push(`expiry_warn_days=$${i++}`);    vals.push(cmd.expiryWarnDays); }
    if (cmd.isActive !== undefined)         { sets.push(`is_active=$${i++}`);           vals.push(cmd.isActive); }
    if (!sets.length) throw new Error('Nothing to update');
    sets.push(`updated_at=NOW()`);
    vals.push(cmd.industryId);
    const [row] = await query<any>(
      `UPDATE industry_configs SET ${sets.join(',')} WHERE industry_id=$${i} RETURNING *`, vals
    );
    if (!row) throw new Error('Industry config not found');
    return row;
  }
}

interface DeleteIndustryCommand extends ICommand {
  readonly type: 'industry.delete';
  industryId: string;
}

class DeleteIndustryCommandHandler implements ICommandHandler<DeleteIndustryCommand> {
  async execute(cmd: DeleteIndustryCommand) {
    // Check no tenants are using it
    const tenantCount = await queryOne<any>(
      'SELECT COUNT(*)::int as count FROM tenants WHERE industry_id=$1 AND is_active=TRUE',
      [cmd.industryId]
    );
    if ((tenantCount?.count || 0) > 0) {
      throw new Error(`Cannot deactivate — ${tenantCount?.count} active tenant(s) using this industry`);
    }
    await query(
      `UPDATE industry_configs SET is_active=FALSE, updated_at=NOW() WHERE industry_id=$1`,
      [cmd.industryId]
    );
    return { message: `Industry "${cmd.industryId}" deactivated` };
  }
}

// ── Queries ──────────────────────────────────────────────────

interface ListIndustriesQuery extends IQuery {
  readonly type: 'industry.list';
  includeInactive?: boolean;
}

class ListIndustriesQueryHandler implements IQueryHandler<ListIndustriesQuery, any[]> {
  async execute(q: ListIndustriesQuery) {
    const where = q.includeInactive ? '' : 'WHERE is_active=TRUE';
    return query<any>(`SELECT id, id as "industry_id", display_name FROM industry_configs ${where} ORDER BY display_name`);
  }
}

interface GetIndustryQuery extends IQuery {
  readonly type: 'industry.get';
  industryId: string;
}

class GetIndustryQueryHandler implements IQueryHandler<GetIndustryQuery, any> {
  async execute(q: GetIndustryQuery) {
    const row = await queryOne<any>(
      `SELECT ic.*,
              COUNT(t.id)::int as tenant_count,
              COUNT(t.id) FILTER (WHERE t.billing_status='active')::int as active_tenants
       FROM industry_configs ic
       LEFT JOIN tenants t ON t.industry_id=ic.industry_id
       WHERE ic.industry_id=$1
       GROUP BY ic.id, ic.industry_id`,
      [q.industryId]
    );
    if (!row) throw new Error('Industry config not found');
    return row;
  }
}

interface GetIndustryStatsQuery extends IQuery {
  readonly type: 'industry.stats';
}

class GetIndustryStatsQueryHandler implements IQueryHandler<GetIndustryStatsQuery, any[]> {
  async execute(_q: GetIndustryStatsQuery) {
    return query<any>(
      `SELECT ic.industry_id, ic.display_name, ic.is_active,
              COUNT(t.id)::int as total_tenants,
              COUNT(t.id) FILTER (WHERE t.billing_status='active')::int as active_tenants,
              COUNT(t.id) FILTER (WHERE t.billing_status='trial')::int as trial_tenants,
              COALESCE(SUM(bp.price_monthly_inr) FILTER (WHERE t.billing_status IN ('active','past_due')),0) as total_mrr
       FROM industry_configs ic
       LEFT JOIN tenants t ON t.industry_id=ic.industry_id AND t.is_active=TRUE
       LEFT JOIN billing_plans bp ON bp.plan_type=t.plan_type
       GROUP BY ic.id, ic.industry_id, ic.display_name, ic.is_active
       ORDER BY total_tenants DESC`
    );
  }
}

// ── Register ─────────────────────────────────────────────────
commandBus.register('industry.create', new CreateIndustryCommandHandler());
commandBus.register('industry.update', new UpdateIndustryCommandHandler());
commandBus.register('industry.delete', new DeleteIndustryCommandHandler());
queryBus.register('industry.list',     new ListIndustriesQueryHandler());
queryBus.register('industry.get',      new GetIndustryQueryHandler());
queryBus.register('industry.stats',    new GetIndustryStatsQueryHandler());

// ── Validation ────────────────────────────────────────────────
const CreateIndustrySchema = z.object({
  industryId: z.string().min(2).regex(/^[a-z0-9_]+$/, 'Must be lowercase alphanumeric with underscores'),
  displayName: z.string().min(2),
  itemNoun: z.string().min(1),
  defaultUnitSymbol: z.string().min(1),
  domainKeywords: z.array(z.string()).min(1),
  offTopicKeywords: z.array(z.string()).default([]),
  seasonalSignals: z.array(z.string()).default([]),
  promptContext: z.string().min(10),
  lowStockDays: z.number().int().positive().default(5),
  expiryWarnDays: z.number().int().positive().default(30),
});

const UpdateIndustrySchema = z.object({
  displayName: z.string().optional(),
  itemNoun: z.string().optional(),
  defaultUnitSymbol: z.string().optional(),
  domainKeywords: z.array(z.string()).optional(),
  offTopicKeywords: z.array(z.string()).optional(),
  seasonalSignals: z.array(z.string()).optional(),
  promptContext: z.string().optional(),
  lowStockDays: z.number().int().positive().optional(),
  expiryWarnDays: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
});

// ── Router ────────────────────────────────────────────────────
export const industryRouter = Router();

// GET /v1/industries  — public
industryRouter.get('/', async (req, res) => {
  try {
    const r = await queryBus.execute<any>({
      type: 'industry.list',
      includeInactive: req.query.includeInactive === 'true',
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// GET /v1/industries/stats  [superadmin]
industryRouter.get('/stats', authMiddleware, requireRole('superadmin'), async (_req, res) => {
  try {
    const r = await queryBus.execute<any>({ type: 'industry.stats' });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// GET /v1/industries/:id  — public
industryRouter.get('/:id', async (req, res) => {
  try {
    const r = await queryBus.execute<any>({ type: 'industry.get', industryId: req.params.id });
    ok(res, r);
  } catch (e: any) { fail(res, e.message, 404); }
});

// POST /v1/industries  [superadmin]
industryRouter.post('/', authMiddleware, requireRole('superadmin'), async (req, res) => {
  try {
    const body = CreateIndustrySchema.parse(req.body);
    const r = await commandBus.execute<any>({ type: 'industry.create', ...body });
    ok(res, r, 201);
  } catch (e: any) { fail(res, e.message); }
});

// PUT /v1/industries/:id  [superadmin]
industryRouter.put('/:id', authMiddleware, requireRole('superadmin'), async (req, res) => {
  try {
    const body = UpdateIndustrySchema.parse(req.body);
    const r = await commandBus.execute<any>({ type: 'industry.update', industryId: req.params.id, ...body });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// DELETE /v1/industries/:id  [superadmin]
industryRouter.delete('/:id', authMiddleware, requireRole('superadmin'), async (req, res) => {
  try {
    const r = await commandBus.execute<any>({ type: 'industry.delete', industryId: req.params.id });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});