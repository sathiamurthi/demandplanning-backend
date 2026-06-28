// ============================================================
// AI MODULE — Full CQRS: Forecast + Semantic Search + Orders
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { callGemini } from './gemini.service';
import { query, queryOne, withTransaction } from '../../config/db';
import { commandBus, ICommand, ICommandHandler } from '../../cqrs/commandBus';
import { queryBus, IQuery, IQueryHandler } from '../../cqrs/queryBus';
import { authMiddleware } from '../auth/auth.service';
import { requireMinRole, requireRole } from '../../core/guards/roleGuard';
import { logAIUsage } from '../superadmin/ai-pipeline.service';

function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}

// ── 12-Layer Sanitizer ────────────────────────────────────────
function sanitizePrompt(input: string, config: any): { clean: string; blocked: boolean; reason?: string; warnings: string[] } {
  const warnings: string[] = [];
  // L1: Encoding normalisation
  let text = (input || '').normalize('NFC')
    .replace(/\0/g, '').replace(/^\uFEFF/, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();

  // L2: Length guard
  if (!text) return { clean: '', blocked: true, reason: 'Empty input', warnings };
  if (text.length > 300) { text = text.slice(0, 300); warnings.push('Truncated to 300 chars'); }

  // L3: Dangerous content
  if (/lethal\s*dose|how\s*to\s*poison|get\s*high\s*on/i.test(text))
    return { clean: '', blocked: true, reason: 'Dangerous content', warnings };

  // L4: Injection attacks
  const injections = [
    'ignore previous', 'ignore above', 'forget everything', 'act as', 'you are now',
    'jailbreak', 'dan mode', 'reveal your prompt', 'system prompt', 'override instruction',
    'new instruction', '<|system|>', '[system]', 'disregard all',
  ];
  if (injections.some(p => text.toLowerCase().includes(p)))
    return { clean: '', blocked: true, reason: 'Injection attempt detected', warnings };

  // L5: PII removal
  const before = text;
  text = text
    .replace(/\b[6-9]\d{9}\b/g, '[PHONE]')
    .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[AADHAAR]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g, '[EMAIL]')
    .replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, '[PAN]');
  if (text !== before) warnings.push('PII redacted');

  // L6: Unicode / homoglyph normalisation
  const homoglyphs: Record<string, string> = {
    'а':'a','е':'e','о':'o','р':'p','с':'c','у':'y','х':'x',
    '\u200B':' ','\u200C':' ','\u200D':' ',
  };
  let changed = false;
  const normalized = [...text].map(c => { const m = homoglyphs[c]; if(m){changed=true;return m;} return c; }).join('');
  if (changed) { text = normalized; warnings.push('Homoglyphs normalised'); }

  // L7: Domain relevance check (industry-aware)
  const lower = text.toLowerCase();
  if (config?.off_topic_keywords?.some((k: string) => lower.includes(k)))
    return { clean: '', blocked: true, reason: 'Query outside domain', warnings };
  if (config?.domain_keywords?.length && !config.domain_keywords.some((k: string) => lower.includes(k)))
    warnings.push('Weak domain match — proceeding with caution');

  // L8: Special characters strip
  const before2 = text;
  text = text
    .replace(/[{}\[\]]/g, '').replace(/\{\{[^}]*\}\}/g, '')
    .replace(/#{1,6}\s/g, '').replace(/\*{1,3}/g, '')
    .replace(/```[^`]*```/g, '').replace(/<[^>]+>/g, '')
    .replace(/"/g, "'").replace(/\\/g, ' ')
    .replace(/ {2,}/g, ' ').trim();
  if (text !== before2) warnings.push('Special chars stripped');

  // L9: Output manipulation attempts
  const outputManip = ['respond in html', "don't use json", 'return plain text', 'ignore json', 'use markdown', 'forget json'];
  if (outputManip.some(p => lower.includes(p)))
    return { clean: '', blocked: true, reason: 'Output manipulation attempt', warnings };

  // L10: Repeated pattern detection (loop attempts)
  if (/(.{10,})\1{3,}/.test(text))
    return { clean: '', blocked: true, reason: 'Repeated pattern detected', warnings };

  // L11: Script / code injection
  if (/(script|eval|exec|import|require|fetch|xhr|axios)\s*[\(]/i.test(text))
    return { clean: '', blocked: true, reason: 'Script injection attempt', warnings };

  // L12: Max consecutive special chars
  if (/[^a-zA-Z0-9\s]{10,}/.test(text))
    return { clean: '', blocked: true, reason: 'Excessive special characters', warnings };

  return { clean: text.trim(), blocked: false, warnings };
}

function sanitizeEmail(raw: string): string | null {
  const clean = (raw || '').trim().toLowerCase().split('\n')[0].split('\r')[0].trim();
  if (clean.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? clean : null;
}

// ── Commands ──────────────────────────────────────────────────

interface GenerateForecastCommand extends ICommand {
  readonly type: 'ai.forecast.generate';
  storeId: string;
  tenantId: string;
  industryId: string;
  email: string;
  itemIds?: string[];
  includeExpiring?: boolean;
  includeSeasonal?: boolean;
}

class GenerateForecastCommandHandler implements ICommandHandler<GenerateForecastCommand> {
  private anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY });

  async execute(cmd: GenerateForecastCommand) {
    // 1. Billing / usage limit check
    const tenantInfo = await queryOne<any>(
      `SELECT t.*, bp.ai_reports_per_month,
              COALESCE(tu.ai_reports_used, 0) as reports_used
       FROM tenants t
       JOIN billing_plans bp ON bp.plan_type = t.plan_type
       LEFT JOIN tenant_usage tu ON tu.tenant_id = t.id AND tu.month = DATE_TRUNC('month', NOW())
       WHERE t.id = $1`,
      [cmd.tenantId]
    );
    if (!tenantInfo) throw new Error('Tenant not found');
    if (tenantInfo.billing_status === 'suspended' || tenantInfo.billing_status === 'cancelled')
      throw new Error('Account suspended — please contact support');
    if (tenantInfo.ai_reports_per_month !== -1 && tenantInfo.reports_used >= tenantInfo.ai_reports_per_month)
      throw new Error(`AI report monthly limit reached (${tenantInfo.ai_reports_per_month}/month). Upgrade your plan.`);

    // 2. Sanitize email — kept completely separate, NEVER enters AI prompt
    const cleanEmail = sanitizeEmail(cmd.email);
    if (!cleanEmail) throw new Error('Invalid email address');

    // 3. Load industry config
    const config = await queryOne<any>('SELECT * FROM industry_configs WHERE industry_id=$1', [cmd.industryId]);
    if (!config) throw new Error(`Industry config not found: ${cmd.industryId}`);

    // 4. Load items to analyze
    const baseQuery = `
      SELECT i.id, i.name, i.current_stock, i.reorder_level, i.lead_time_days,
             i.monthly_usage_avg, i.season_flag, i.is_seasonal, i.expiry_date,
             i.batch_number, i.purchase_price, i.selling_price,
             ut.symbol as unit
      FROM items i
      LEFT JOIN unit_types ut ON ut.id = i.primary_unit_id
      WHERE i.store_id = $1 AND i.is_active = TRUE`;

    let itemsResult: any[];
    if (cmd.itemIds?.length) {
      itemsResult = await query<any>(`${baseQuery} AND i.id = ANY($2)`, [cmd.storeId, cmd.itemIds]);
    } else {
      // Auto-select: low stock + optionally expiring + seasonal
      const conditions: string[] = ['i.current_stock <= i.reorder_level * 1.5'];
      if (cmd.includeExpiring)
        conditions.push(`(i.expiry_date <= NOW() + INTERVAL '${config.expiry_warn_days} days' AND i.expiry_date IS NOT NULL)`);
      if (cmd.includeSeasonal)
        conditions.push('i.is_seasonal = TRUE');
      itemsResult = await query<any>(
        `${baseQuery} AND (${conditions.join(' OR ')}) ORDER BY i.current_stock ASC LIMIT 20`,
        [cmd.storeId]
      );
    }

    if (!itemsResult.length) {
      return {
        results: [], message: 'No items require forecasting at this time.',
        email: cleanEmail, storeId: cmd.storeId, industryId: cmd.industryId,
        totalCount: 0, generatedAt: new Date().toISOString(),
      };
    }

    // 5. Sanitize all item names through 12-layer sanitizer
    const sanitizedItems = itemsResult.map(item => {
      const s = sanitizePrompt(item.name, config);
      return {
        ...item,
        sanitized_name: s.blocked ? item.name.slice(0, 50).replace(/[<>"]/g, '') : s.clean,
        sanitize_warnings: s.warnings,
      };
    });

    // 6. Build AI prompt — email NEVER included
    const promptData = sanitizedItems.map(i => ({
      id: i.id,
      name: i.sanitized_name,
      current_stock: parseFloat(i.current_stock),
      unit: i.unit || config.default_unit_symbol,
      monthly_usage: parseFloat(i.monthly_usage_avg) || 0,
      reorder_level: parseFloat(i.reorder_level),
      lead_time_days: i.lead_time_days || 4,
      season: i.season_flag || config.seasonal_signals[0] || 'normal',
      expiry_date: i.expiry_date || null,
    }));

    const prompt = `You are a ${config.prompt_context}.
Analyze each ${config.item_noun.toLowerCase()} and forecast demand for the next 30 days.
Consider: current stock levels, monthly usage, reorder levels, lead times, and seasonal factors.

Respond ONLY with a valid JSON array — no markdown, no preamble, no extra text:
[{
  "id": "<exact item id>",
  "item": "<item name>",
  "predicted_qty_30d": <positive integer — units needed next 30 days>,
  "confidence_pct": <integer 0-100>,
  "order_needed": <true if current_stock < predicted_qty_30d>,
  "order_qty": <integer — recommended order quantity>,
  "risk_level": "<Low|Medium|High|Critical>",
  "reasoning": "<one concise sentence, max 150 chars>"
}]

Items to analyze:
${JSON.stringify(promptData, null, 2)}`;

    // 7. Call AI Service — email stays out of the prompt entirely
    let modelName: string;
    let rawText = '';
    let promptTokens = 0;
    let completionTokens = 0;
    const _t0Forecast = Date.now();

    if (process.env.AI_PROVIDER === 'gemini') {
      try {
        const geminiRes = await callGemini({
          prompt: prompt,
          maxTokens: 2000,
          responseMimeType: 'application/json',
        });
        modelName = geminiRes.model;
        rawText = geminiRes.text;
        promptTokens = geminiRes.inputTokens;
        completionTokens = geminiRes.outputTokens;
        await logAIUsage({ feature: 'forecast', model: modelName, promptTokens, completionTokens, latencyMs: Date.now() - _t0Forecast, status: 'success', tenantId: cmd.tenantId, storeId: cmd.storeId });
      } catch (err: any) {
        await logAIUsage({ feature: 'forecast', model: process.env.GEMINI_MODEL || 'gemini-2.5-flash', promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - _t0Forecast, status: 'error', errorMsg: err.message, tenantId: cmd.tenantId, storeId: cmd.storeId });
        throw new Error(`AI service error: ${err.message}`);
      }
    } else {
      try {
        const aiMessage = await this.anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }],
        });
        modelName = 'claude-sonnet-4-20250514';
        rawText = (aiMessage.content[0] as any).text;
        promptTokens = aiMessage.usage.input_tokens;
        completionTokens = aiMessage.usage.output_tokens;
        await logAIUsage({ feature: 'forecast', model: modelName, promptTokens, completionTokens, latencyMs: Date.now() - _t0Forecast, status: 'success', tenantId: cmd.tenantId, storeId: cmd.storeId });
      } catch (err: any) {
        await logAIUsage({ feature: 'forecast', model: 'claude-sonnet-4-20250514', promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - _t0Forecast, status: 'error', errorMsg: err.message, tenantId: cmd.tenantId, storeId: cmd.storeId });
        throw new Error(`AI service error: ${err.message}`);
      }
    }

    // 8. Parse + validate AI output with Zod
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    let parsed: any[];
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error('AI returned invalid JSON — please try again');
    }

    const ForecastItemSchema = z.object({
      id: z.string(),
      item: z.string(),
      predicted_qty_30d: z.number().int().min(0),
      confidence_pct: z.number().int().min(0).max(100),
      order_needed: z.boolean(),
      order_qty: z.number().int().min(0),
      risk_level: z.enum(['Low', 'Medium', 'High', 'Critical']),
      reasoning: z.string().max(300),
    });

    const aiResults = parsed.map((r: any) => {
      const validated = ForecastItemSchema.parse(r);
      return {
        itemId: validated.id,
        item: validated.item,
        predictedQty30d: validated.predicted_qty_30d,
        confidencePct: validated.confidence_pct,
        orderNeeded: validated.order_needed,
        orderQty: validated.order_qty,
        riskLevel: validated.risk_level,
        reasoning: validated.reasoning,
      };
    });

    // 9. Attach sanitized email to each result AFTER AI processing
    const payloads = aiResults.map(r => ({
      aiResult: r,
      email: cleanEmail,          // attached here — never went into prompt
      timestamp: new Date().toISOString(),
      storeId: cmd.storeId,
      industryId: cmd.industryId,
    }));

    // 10. Persist to DB
    await withTransaction(async (client) => {
      for (const p of payloads) {
        await client.query(
          `INSERT INTO ai_forecasts
             (store_id, tenant_id, item_id, predicted_qty_30d, confidence_pct, order_needed,
              order_qty, risk_level, reasoning, notify_email, industry_id, model_version,
              prompt_tokens, completion_tokens)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            cmd.storeId, cmd.tenantId, p.aiResult.itemId || null,
            p.aiResult.predictedQty30d, p.aiResult.confidencePct,
            p.aiResult.orderNeeded, p.aiResult.orderQty, p.aiResult.riskLevel,
            p.aiResult.reasoning, p.email, cmd.industryId,
            modelName,
            promptTokens,
            completionTokens,
          ]
        );

        // Auto-create alerts for High/Critical items
        if (p.aiResult.riskLevel === 'Critical' || p.aiResult.riskLevel === 'High') {
          await client.query(
            `INSERT INTO ai_alerts
               (store_id, tenant_id, item_id, alert_type, message, severity)
             VALUES ($1,$2,$3,'reorder',$4,$5)`,
            [
              cmd.storeId, cmd.tenantId, p.aiResult.itemId || null,
              `AI Forecast: "${p.aiResult.item}" — ${p.aiResult.reasoning}`,
              p.aiResult.riskLevel === 'Critical' ? 'critical' : 'warning',
            ]
          );
        }
      }

      // Increment tenant usage counter
      await client.query(
        `INSERT INTO tenant_usage (tenant_id, month, ai_reports_used)
         VALUES ($1, DATE_TRUNC('month', NOW()), 1)
         ON CONFLICT (tenant_id, month)
         DO UPDATE SET ai_reports_used = tenant_usage.ai_reports_used + 1, updated_at = NOW()`,
        [cmd.tenantId]
      );
    });

    return {
      storeId: cmd.storeId,
      industryId: cmd.industryId,
      email: cleanEmail,
      results: payloads,
      totalCount: payloads.length,
      generatedAt: new Date().toISOString(),
      tokensUsed: promptTokens + completionTokens,
      sanitizerWarnings: sanitizedItems.flatMap(i => i.sanitize_warnings),
    };
  }
}

// Semantic Search Command
interface AISearchCommand extends ICommand {
  readonly type: 'ai.search';
  storeId: string;
  tenantId: string;
  industryId: string;
  query: string;
}

class AISearchCommandHandler implements ICommandHandler<AISearchCommand> {
  private anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY });

  async execute(cmd: AISearchCommand) {
    const config = await queryOne<any>('SELECT * FROM industry_configs WHERE industry_id=$1', [cmd.industryId]);
    const sanitized = sanitizePrompt(cmd.query, config);
    if (sanitized.blocked) throw new Error(`Query blocked: ${sanitized.reason}`);

    // First try DB text search
    const dbResults = await query<any>(
      `SELECT i.id, i.name, i.current_stock, i.reorder_level, i.selling_price, i.expiry_date,
              ut.symbol as unit, c.name as category
       FROM items i
       LEFT JOIN unit_types ut ON ut.id=i.primary_unit_id
       LEFT JOIN categories c ON c.id=i.category_id
       WHERE i.store_id=$1 AND i.tenant_id=$2 AND i.is_active=TRUE
         AND (i.name ILIKE $3 OR i.sku ILIKE $3 OR i.brand ILIKE $3)
       LIMIT 10`,
      [cmd.storeId, cmd.tenantId, `%${sanitized.clean}%`]
    );

    if (dbResults.length >= 3) return { results: dbResults, source: 'database', query: sanitized.clean };

    // AI-powered semantic search for better results
    const allItems = await query<any>(
      `SELECT id, name, sku, brand, current_stock, reorder_level, selling_price FROM items
       WHERE store_id=$1 AND tenant_id=$2 AND is_active=TRUE LIMIT 100`,
      [cmd.storeId, cmd.tenantId]
    );
    if (!allItems.length) return { results: [], source: 'empty', query: sanitized.clean };

    const prompt = `You are a ${config?.item_noun || 'inventory'} search assistant.
Given a search query and a list of items, return the IDs of the most relevant items.
Search query: "${sanitized.clean}"
Items: ${JSON.stringify(allItems.map(i => ({ id: i.id, name: i.name, brand: i.brand })))}
Respond ONLY with a JSON array of item IDs, most relevant first, max 10: ["id1","id2",...]`;

    const _t0Search = Date.now();
    let rawText = '';

    if (process.env.AI_PROVIDER === 'gemini') {
      try {
        const geminiRes = await callGemini({
          prompt: prompt,
          maxTokens: 200,
          responseMimeType: 'application/json',
        });
        rawText = geminiRes.text;
        await logAIUsage({
          feature: 'search',
          model: geminiRes.model,
          promptTokens: geminiRes.inputTokens,
          completionTokens: geminiRes.outputTokens,
          latencyMs: Date.now() - _t0Search,
          status: 'success',
        });
      } catch (err: any) {
        await logAIUsage({
          feature: 'search',
          model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: Date.now() - _t0Search,
          status: 'error',
          errorMsg: err.message,
        });
        throw new Error(`AI search service error: ${err.message}`);
      }
    } else {
      try {
        const msg = await this.anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        });
        rawText = (msg.content[0] as any).text;
        await logAIUsage({
          feature: 'search',
          model: 'claude-sonnet-4-20250514',
          promptTokens: msg.usage.input_tokens,
          completionTokens: msg.usage.output_tokens,
          latencyMs: Date.now() - _t0Search,
          status: 'success',
        });
      } catch (err: any) {
        await logAIUsage({
          feature: 'search',
          model: 'claude-sonnet-4-20250514',
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: Date.now() - _t0Search,
          status: 'error',
          errorMsg: err.message,
        });
        throw new Error(`AI search service error: ${err.message}`);
      }
    }

    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const ids: string[] = JSON.parse(cleaned);
    const results = allItems.filter(i => ids.includes(i.id)).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    return { results, source: 'ai', query: sanitized.clean };
  }
}

// ── Queries ───────────────────────────────────────────────────

interface GetForecastHistoryQuery extends IQuery {
  readonly type: 'ai.forecast.history';
  storeId: string;
  tenantId: string;
  itemId?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

class GetForecastHistoryQueryHandler implements IQueryHandler<GetForecastHistoryQuery, any> {
  async execute(q: GetForecastHistoryQuery) {
    const conds = ['af.store_id=$1', 'af.tenant_id=$2'];
    const vals: any[] = [q.storeId, q.tenantId]; let i = 3;
    if (q.itemId) { conds.push(`af.item_id=$${i++}`); vals.push(q.itemId); }
    if (q.from)   { conds.push(`af.created_at >= $${i++}`); vals.push(q.from); }
    if (q.to)     { conds.push(`af.created_at <= $${i++}`); vals.push(q.to); }
    vals.push(q.limit, q.offset);
    const rows = await query<any>(
      `SELECT af.*, i.name as item_name, i.current_stock, ut.symbol as unit_symbol
       FROM ai_forecasts af
       LEFT JOIN items i ON i.id = af.item_id
       LEFT JOIN unit_types ut ON ut.id = i.primary_unit_id
       WHERE ${conds.join(' AND ')}
       ORDER BY af.created_at DESC
       LIMIT $${i} OFFSET $${i+1}`,
      vals
    );
    const [{ count }] = await query<any>(
      `SELECT COUNT(*) FROM ai_forecasts af WHERE ${conds.slice(0,-2).join(' AND ')}`,
      vals.slice(0,-2)
    );
    return { items: rows, total: parseInt(count), limit: q.limit, offset: q.offset };
  }
}

interface GetLatestForecastQuery extends IQuery {
  readonly type: 'ai.forecast.latest';
  storeId: string;
  tenantId: string;
  riskLevel?: string;
}

class GetLatestForecastQueryHandler implements IQueryHandler<GetLatestForecastQuery, any[]> {
  async execute(q: GetLatestForecastQuery) {
    const riskFilter = q.riskLevel ? `AND af.risk_level = '${q.riskLevel}'` : '';
    return query<any>(
      `SELECT DISTINCT ON (af.item_id)
              af.*, i.name as item_name, i.current_stock, i.reorder_level,
              ut.symbol as unit_symbol
       FROM ai_forecasts af
       LEFT JOIN items i ON i.id = af.item_id
       LEFT JOIN unit_types ut ON ut.id = i.primary_unit_id
       WHERE af.store_id=$1 AND af.tenant_id=$2 ${riskFilter}
       ORDER BY af.item_id, af.created_at DESC`,
      [q.storeId, q.tenantId]
    );
  }
}

interface GetForecastSummaryQuery extends IQuery {
  readonly type: 'ai.forecast.summary';
  storeId: string;
  tenantId: string;
}

class GetForecastSummaryQueryHandler implements IQueryHandler<GetForecastSummaryQuery, any> {
  async execute(q: GetForecastSummaryQuery) {
    const summary = await queryOne<any>(
      `SELECT
         COUNT(DISTINCT af.item_id)::int as items_analyzed,
         COUNT(af.id) FILTER (WHERE af.risk_level='Critical')::int as critical_count,
         COUNT(af.id) FILTER (WHERE af.risk_level='High')::int as high_count,
         COUNT(af.id) FILTER (WHERE af.risk_level='Medium')::int as medium_count,
         COUNT(af.id) FILTER (WHERE af.risk_level='Low')::int as low_count,
         COUNT(af.id) FILTER (WHERE af.order_needed=TRUE)::int as orders_needed,
         MAX(af.created_at) as last_run_at
       FROM ai_forecasts af
       WHERE af.store_id=$1 AND af.tenant_id=$2`,
      [q.storeId, q.tenantId]
    );
    const usage = await queryOne<any>(
      `SELECT tu.ai_reports_used, bp.ai_reports_per_month
       FROM tenants t
       JOIN billing_plans bp ON bp.plan_type=t.plan_type
       LEFT JOIN tenant_usage tu ON tu.tenant_id=t.id AND tu.month=DATE_TRUNC('month',NOW())
       WHERE t.id=$1`,
      [q.tenantId]
    );
    return { ...summary, ...usage };
  }
}

// ── Register ──────────────────────────────────────────────────
commandBus.register('ai.forecast.generate', new GenerateForecastCommandHandler());
commandBus.register('ai.search',            new AISearchCommandHandler());
queryBus.register('ai.forecast.history',    new GetForecastHistoryQueryHandler());
queryBus.register('ai.forecast.latest',     new GetLatestForecastQueryHandler());
queryBus.register('ai.forecast.summary',    new GetForecastSummaryQueryHandler());

// ── Validation ─────────────────────────────────────────────────
const GenerateSchema = z.object({
  email: z.string().email('Valid email required for result tagging'),
  itemIds: z.array(z.string().uuid()).optional(),
  includeExpiring: z.boolean().default(true),
  includeSeasonal: z.boolean().default(true),
});

// ── Router ─────────────────────────────────────────────────────
export const aiRouter = Router({ mergeParams: true });
aiRouter.use(authMiddleware);

// POST /v1/stores/:storeId/report/generate
aiRouter.post('/generate', requireMinRole('manager'), async (req, res) => {
  try {
    const user = (req as any).user;
    const store = await queryOne<any>(
      `SELECT s.*, ic.industry_id AS industry_id, ic.id AS industry_uuid
       FROM stores s
       LEFT JOIN tenant_industry ti ON ti.tenant_id = s.tenant_id
       LEFT JOIN industry_configs ic ON ic.id = ti.industry_id
       WHERE s.id = $1 AND s.tenant_id = $2`,
      [req.params.storeId, user.tenantId]
    );
    if (!store) return fail(res, 'Store not found', 404);
    const body = GenerateSchema.parse(req.body);
    const r = await commandBus.execute<any>({
      type: 'ai.forecast.generate',
      storeId: req.params.storeId,
      tenantId: user.tenantId,
      industryId: store.industry_id || 'general',
      ...body,
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// GET /v1/stores/:storeId/report/history
aiRouter.get('/history', async (req, res) => {
  try {
    const user = (req as any).user;
    const storeId = (req.params as any).storeId;

    const r = await queryBus.execute<any>({
      type: 'ai.forecast.history',
      storeId: storeId, tenantId: user.tenantId,
      itemId: req.query.itemId as string,
      from: req.query.from as string, to: req.query.to as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// GET /v1/stores/:storeId/report/latest
aiRouter.get('/latest', async (req, res) => {
  try {
    const user = (req as any).user;
    const storeId = (req.params as any).storeId;
    const r = await queryBus.execute<any>({
      type: 'ai.forecast.latest',
      storeId: storeId, tenantId: user.tenantId,
      riskLevel: req.query.riskLevel as string,
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// GET /v1/stores/:storeId/report/summary
aiRouter.get('/summary', async (req, res) => {
  try {
    const user = (req as any).user;
    const storeId = (req.params as any).storeId;

    const r = await queryBus.execute<any>({
      type: 'ai.forecast.summary',
      storeId: storeId, tenantId: user.tenantId,
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// POST /v1/stores/:storeId/report/suggest — AI item field suggestions
aiRouter.post('/suggest', async (req, res) => {
  try {
    const user = (req as any).user;
    const storeId = (req.params as any).storeId;
    const { name } = req.body as { name: string };
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return fail(res, 'name is required (min 2 chars)');
    }

    const store = await queryOne<any>(
      `SELECT s.*, ic.item_noun, ic.prompt_context, ic.industry_id AS industry_slug
       FROM stores s
       LEFT JOIN tenant_industry ti ON ti.tenant_id = s.tenant_id
       LEFT JOIN industry_configs ic ON ic.id = ti.industry_id
       WHERE s.id = $1 AND s.tenant_id = $2`,
      [storeId, user.tenantId]
    );

    const sanitized = sanitizePrompt(name.trim(), store);
    if (sanitized.blocked) return fail(res, `Input blocked: ${sanitized.reason}`);

    const prompt = `You are an inventory management assistant for a ${store?.prompt_context || 'retail store'}.
Given the ${store?.item_noun || 'item'} name: "${sanitized.clean}"
Suggest the following fields. Respond ONLY with valid JSON — no markdown, no preamble:
{
  "suggestedSku": "<short uppercase slug, e.g. MED-PARA-500>",
  "suggestedCategory": "<most likely category name, e.g. Medicines, Beverages, Electronics>",
  "suggestedReorderLevel": <integer — typical minimum stock before reorder>,
  "estimatedPriceRange": { "min": <number>, "max": <number> },
  "isSeasonal": <boolean>,
  "notes": "<one sentence of useful context for this item, max 100 chars>"
}`;

    const _t0Suggest = Date.now();
    let rawText = '';

    if (process.env.AI_PROVIDER === 'gemini') {
      try {
        const geminiRes = await callGemini({
          prompt: prompt,
          maxTokens: 300,
          responseMimeType: 'application/json',
        });
        rawText = geminiRes.text;
        await logAIUsage({
          feature: 'suggest',
          model: geminiRes.model,
          promptTokens: geminiRes.inputTokens,
          completionTokens: geminiRes.outputTokens,
          latencyMs: Date.now() - _t0Suggest,
          status: 'success',
        });
      } catch (err: any) {
        await logAIUsage({
          feature: 'suggest',
          model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: Date.now() - _t0Suggest,
          status: 'error',
          errorMsg: err.message,
        });
        throw new Error(`AI suggest service error: ${err.message}`);
      }
    } else {
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY });
        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }],
        });
        rawText = (msg.content[0] as any).text;
        await logAIUsage({
          feature: 'suggest',
          model: 'claude-haiku-4-5-20251001',
          promptTokens: msg.usage.input_tokens,
          completionTokens: msg.usage.output_tokens,
          latencyMs: Date.now() - _t0Suggest,
          status: 'success',
        });
      } catch (err: any) {
        await logAIUsage({
          feature: 'suggest',
          model: 'claude-haiku-4-5-20251001',
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: Date.now() - _t0Suggest,
          status: 'error',
          errorMsg: err.message,
        });
        throw new Error(`AI suggest service error: ${err.message}`);
      }
    }

    const cleaned = rawText.replace(/```json|```/g, '').trim();
    let suggestion: any;
    try {
      suggestion = JSON.parse(cleaned);
    } catch {
      return fail(res, 'AI returned invalid JSON — please try again');
    }

    ok(res, suggestion);
  } catch (e: any) { fail(res, e.message); }
});

// ── Tenant AI Settings router ─────────────────────────────────
export const aiSettingsRouter = Router({ mergeParams: true });
aiSettingsRouter.use(authMiddleware);

// GET /v1/tenants/:tenantId/ai-settings
aiSettingsRouter.get('/', async (req, res) => {
  try {
    const user = (req as any).user;
    const tenantId = (req.params as any).tenantId;
    if (user.tenantId !== tenantId && user.role !== 'superadmin')
      return fail(res, 'Forbidden', 403);

    const info = await queryOne<any>(
      `SELECT t.plan_type, t.name AS tenant_name, t.billing_status,
              bp.ai_reports_per_month, bp.whatsapp_alerts, bp.api_access, bp.custom_industry,
              COALESCE(tu.ai_reports_used, 0)::int AS reports_used,
              (SELECT COUNT(*)::int FROM tenant_industry WHERE tenant_id = t.id) AS industry_count,
              (SELECT json_agg(json_build_object('slug', ic.industry_id, 'label', ic.display_name))
               FROM tenant_industry ti2
               JOIN industry_configs ic ON ic.id = ti2.industry_id
               WHERE ti2.tenant_id = t.id) AS industries
       FROM tenants t
       JOIN billing_plans bp ON bp.plan_type = t.plan_type
       LEFT JOIN tenant_usage tu ON tu.tenant_id = t.id AND tu.month = DATE_TRUNC('month', NOW())
       WHERE t.id = $1`,
      [tenantId]
    );
    if (!info) return fail(res, 'Tenant not found', 404);

    const planTier = ['enterprise', 'growth'].includes(info.plan_type) ? 'advanced' : 'basic';
    const usagePercent = info.ai_reports_per_month === -1
      ? 0
      : Math.round((info.reports_used / info.ai_reports_per_month) * 100);

    ok(res, {
      planType: info.plan_type,
      planTier,
      tenantName: info.tenant_name,
      billingStatus: info.billing_status,
      usage: {
        reportsUsed: info.reports_used,
        reportsLimit: info.ai_reports_per_month,
        usagePercent: Math.min(usagePercent, 100),
        isUnlimited: info.ai_reports_per_month === -1,
      },
      features: {
        basicSuggest:      true,
        lowStockAlerts:    true,
        aiSearch:          planTier === 'advanced' || info.api_access,
        aiForecasting:     planTier === 'advanced',
        seasonalAnalysis:  planTier === 'advanced',
        whatsappAlerts:    info.whatsapp_alerts,
        apiAccess:         info.api_access,
        customIndustry:    info.custom_industry,
        scheduledReports:  planTier === 'advanced',
        bulkForecast:      planTier === 'advanced',
      },
      industries: info.industries || [],
      industryCount: info.industry_count,
    });
  } catch (e: any) { fail(res, e.message); }
});

// GET /v1/stores/:storeId/search?q=
aiRouter.get('/search', async (req, res) => {
  try {
    const user = (req as any).user;
    const storeId = (req.params as any).storeId;

    if (!req.query.q) return fail(res, 'Query parameter "q" is required');
    const store = await queryOne<any>(
      `SELECT s.*, ic.industry_id AS industry_id
       FROM stores s
       LEFT JOIN tenant_industry ti ON ti.tenant_id = s.tenant_id
       LEFT JOIN industry_configs ic ON ic.id = ti.industry_id
       WHERE s.id = $1`,
      [storeId]
    );
    const r = await commandBus.execute<any>({
      type: 'ai.search',
      storeId: storeId, tenantId: user.tenantId,
      industryId: store?.industry_id || 'general',
      query: req.query.q as string,
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});