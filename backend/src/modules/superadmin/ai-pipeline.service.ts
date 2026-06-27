/**
 * AI Agent Pipeline — Sequential multi-agent demand analysis
 *
 * Agents run in order, each receiving the structured output of all prior agents:
 *   DataCollector → TrendAnalyzer → RiskAssessor → ForecastEngine → RecommendationAgent → ReportWriter
 *
 * Every Claude call is logged to ai_usage_logs for the superadmin AI Usage report.
 */

import { query as dbQuery } from '../../config/db';
import { logger } from '../../config/logger';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5-20251001';

function mkClient() {
  return new Anthropic({ apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY });
}

// ── Shared: log every AI call ─────────────────────────────────
export async function logAIUsage(params: {
  feature: string;
  agentName?: string;
  pipelineRunId?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  status: 'success' | 'error';
  errorMsg?: string;
  tenantId?: string;
  storeId?: string;
  metadata?: Record<string, any>;
}) {
  try {
    await dbQuery(
      `INSERT INTO ai_usage_logs
         (feature, agent_name, pipeline_run_id, model, prompt_tokens, completion_tokens,
          latency_ms, status, error_msg, tenant_id, store_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        params.feature,
        params.agentName ?? null,
        params.pipelineRunId ?? null,
        params.model,
        params.promptTokens,
        params.completionTokens,
        params.latencyMs,
        params.status,
        params.errorMsg ?? null,
        params.tenantId ?? null,
        params.storeId ?? null,
        JSON.stringify(params.metadata ?? {}),
      ]
    );
  } catch (e: any) {
    logger.warn('logAIUsage failed:', e.message);
  }
}

// ── Claude helper: call + log + return parsed JSON ────────────
async function callClaude(
  prompt: string,
  agentName: string,
  pipelineRunId: string,
  tenantId: string,
  fallback: any
): Promise<any> {
  const client = mkClient();
  const t0 = Date.now();
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    });
    const ms = Date.now() - t0;
    await logAIUsage({
      feature: 'pipeline',
      agentName,
      pipelineRunId,
      model: MODEL,
      promptTokens: msg.usage.input_tokens,
      completionTokens: msg.usage.output_tokens,
      latencyMs: ms,
      status: 'success',
      tenantId,
    });
    const text = (msg.content[0] as any).text ?? '{}';
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : fallback;
  } catch (err: any) {
    await logAIUsage({
      feature: 'pipeline',
      agentName,
      pipelineRunId,
      model: MODEL,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - t0,
      status: 'error',
      errorMsg: err.message,
      tenantId,
    });
    logger.warn(`[Pipeline:${agentName}] Claude call failed: ${err.message}`);
    return fallback;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGENT 1 — DataCollector (DB only, no Claude)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function agentDataCollector(storeId: string) {
  const [items, recentForecasts] = await Promise.all([
    dbQuery<any>(
      `SELECT id, name, sku, category, unit_price,
              current_stock, reorder_point, reorder_qty, is_active
       FROM items
       WHERE store_id = $1 AND is_active = TRUE
       ORDER BY name LIMIT 60`,
      [storeId]
    ),
    dbQuery<any>(
      `SELECT item_id, predicted_qty_30d, confidence_pct, order_needed,
              order_qty, risk_level, created_at::text
       FROM ai_forecasts
       WHERE store_id = $1
       ORDER BY created_at DESC LIMIT 40`,
      [storeId]
    ),
  ]);

  const stockAlerts = items.filter(
    (i: any) => parseFloat(i.current_stock) <= parseFloat(i.reorder_point ?? 0)
  );

  const categories = [...new Set(items.map((i: any) => i.category).filter(Boolean))];

  return {
    items,
    recentForecasts,
    stockAlerts,
    categories,
    totalItems: items.length,
    totalAlerts: stockAlerts.length,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGENT 2 — TrendAnalyzer
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function agentTrendAnalyzer(
  dc: Awaited<ReturnType<typeof agentDataCollector>>,
  runId: string,
  tenantId: string
) {
  const itemSample = dc.items.slice(0, 20).map((i: any) => {
    const f = dc.recentForecasts.find((r: any) => r.item_id === i.id);
    return `${i.name} | cat:${i.category ?? 'misc'} | stock:${i.current_stock} | reorder_at:${i.reorder_point ?? 0} | last_forecast:${f?.predicted_qty_30d ?? 'none'}`;
  }).join('\n');

  const prompt = `You are TrendAnalyzer, an inventory trend analysis agent.

STORE SNAPSHOT:
Total items: ${dc.totalItems}
Categories: ${dc.categories.join(', ') || 'uncategorized'}
Items below reorder point: ${dc.totalAlerts}
Recent AI forecasts available: ${dc.recentForecasts.length}

ITEM SAMPLE (up to 20):
${itemSample}

Analyze demand trends and return ONLY valid JSON (no markdown):
{
  "trends": [
    { "category": "string", "direction": "rising|stable|declining", "change_pct": 0, "confidence": 75, "note": "string" }
  ],
  "overallHealth": "critical|warning|good",
  "insights": ["string", "string", "string"]
}`;

  return callClaude(prompt, 'TrendAnalyzer', runId, tenantId, {
    trends: dc.categories.map((c: string) => ({ category: c, direction: 'stable', change_pct: 0, confidence: 50, note: 'Insufficient data' })),
    overallHealth: dc.totalAlerts > dc.totalItems * 0.3 ? 'warning' : 'good',
    insights: ['Inventory levels are being monitored', 'Set up regular forecasting for better trends', 'Add more historical data for accurate analysis'],
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGENT 3 — RiskAssessor
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function agentRiskAssessor(
  dc: Awaited<ReturnType<typeof agentDataCollector>>,
  ta: Awaited<ReturnType<typeof agentTrendAnalyzer>>,
  runId: string,
  tenantId: string
) {
  const criticalItems = dc.stockAlerts.slice(0, 12).map(
    (i: any) => `${i.name} (stock:${i.current_stock}, reorder_at:${i.reorder_point ?? 0})`
  ).join('\n') || 'None';

  const decliningCats = (ta as any).trends
    ?.filter((t: any) => t.direction === 'declining')
    .map((t: any) => t.category)
    .join(', ') || 'none';

  const prompt = `You are RiskAssessor, an inventory risk scoring agent.

PREVIOUS AGENT OUTPUT (TrendAnalyzer):
Overall health: ${(ta as any).overallHealth}
Key insights: ${(ta as any).insights?.join(' | ')}
Declining categories: ${decliningCats}

ITEMS BELOW REORDER POINT (${dc.totalAlerts} of ${dc.totalItems}):
${criticalItems}

Assess inventory risks and return ONLY valid JSON (no markdown):
{
  "risks": [
    { "itemName": "string", "riskType": "stockout|overstock|trend|expiry", "severity": "high|medium|low", "action": "string" }
  ],
  "riskScore": 42,
  "criticalCount": 3,
  "summary": "string"
}`;

  return callClaude(prompt, 'RiskAssessor', runId, tenantId, {
    risks: dc.stockAlerts.slice(0, 5).map((i: any) => ({
      itemName: i.name, riskType: 'stockout', severity: 'high', action: 'Reorder immediately',
    })),
    riskScore: Math.min(100, dc.totalAlerts * 12),
    criticalCount: dc.totalAlerts,
    summary: `${dc.totalAlerts} items below reorder point require attention`,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGENT 4 — ForecastEngine
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function agentForecastEngine(
  dc: Awaited<ReturnType<typeof agentDataCollector>>,
  ta: Awaited<ReturnType<typeof agentTrendAnalyzer>>,
  ra: Awaited<ReturnType<typeof agentRiskAssessor>>,
  runId: string,
  tenantId: string
) {
  const highRisk = (ra as any).risks
    ?.filter((r: any) => r.severity === 'high')
    .map((r: any) => r.itemName)
    .slice(0, 8) || [];

  const priorityItems = dc.items
    .filter((i: any) => highRisk.includes(i.name) || parseFloat(i.current_stock) <= parseFloat(i.reorder_point ?? 0))
    .slice(0, 15)
    .map((i: any) => `${i.name} | price:₹${i.unit_price ?? 0} | stock:${i.current_stock} | reorder_qty:${i.reorder_qty ?? 10}`)
    .join('\n') || dc.items.slice(0, 10).map((i: any) => `${i.name} | price:₹${i.unit_price ?? 0} | stock:${i.current_stock} | reorder_qty:${i.reorder_qty ?? 10}`).join('\n');

  const prompt = `You are ForecastEngine, a 30-day demand forecasting agent.

PREVIOUS AGENT OUTPUTS:
Health: ${(ta as any).overallHealth} | Risk score: ${(ra as any).riskScore}/100
Critical items: ${(ra as any).criticalCount}

PRIORITY ITEMS FOR FORECAST:
${priorityItems}

Generate 30-day demand forecasts and return ONLY valid JSON (no markdown):
{
  "forecasts": [
    { "itemName": "string", "predicted30d": 25, "confidence": 80, "shouldOrder": true, "orderQty": 20, "estimatedCost": 2500 }
  ],
  "totalOrderValue": 15000,
  "forecastConfidence": 75
}`;

  return callClaude(prompt, 'ForecastEngine', runId, tenantId, {
    forecasts: dc.stockAlerts.slice(0, 8).map((i: any) => ({
      itemName: i.name,
      predicted30d: Math.max(1, parseFloat(i.reorder_qty ?? 10)),
      confidence: 60,
      shouldOrder: true,
      orderQty: parseFloat(i.reorder_qty ?? 10),
      estimatedCost: parseFloat(i.unit_price ?? 0) * parseFloat(i.reorder_qty ?? 10),
    })),
    totalOrderValue: dc.stockAlerts.reduce((s: number, i: any) => s + parseFloat(i.unit_price ?? 0) * parseFloat(i.reorder_qty ?? 10), 0),
    forecastConfidence: 60,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGENT 5 — RecommendationAgent
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function agentRecommendationAgent(
  ra: Awaited<ReturnType<typeof agentRiskAssessor>>,
  fe: Awaited<ReturnType<typeof agentForecastEngine>>,
  runId: string,
  tenantId: string
) {
  const ordersNeeded = (fe as any).forecasts?.filter((f: any) => f.shouldOrder) ?? [];

  const prompt = `You are RecommendationAgent, an inventory action prioritization agent.

PREVIOUS AGENT OUTPUTS:
Risk score: ${(ra as any).riskScore}/100 | Critical items: ${(ra as any).criticalCount}
Risk summary: ${(ra as any).summary}
Items needing reorder: ${ordersNeeded.length}
Total order value: ₹${(fe as any).totalOrderValue ?? 0}
Forecast confidence: ${(fe as any).forecastConfidence ?? 0}%

TOP RISKS: ${(ra as any).risks?.slice(0, 5).map((r: any) => `${r.itemName}(${r.severity}): ${r.action}`).join(' | ') || 'none'}
TOP ORDERS: ${ordersNeeded.slice(0, 5).map((f: any) => `${f.itemName}(qty:${f.orderQty},₹${f.estimatedCost})`).join(' | ') || 'none'}

Generate prioritized action plan and return ONLY valid JSON (no markdown):
{
  "recommendations": [
    { "priority": "P1", "action": "string", "impact": "string", "deadline": "Today|This week|This month" }
  ],
  "urgency": "immediate|this_week|next_month",
  "estimatedImpact": "string"
}`;

  return callClaude(prompt, 'RecommendationAgent', runId, tenantId, {
    recommendations: [
      { priority: 'P1', action: `Reorder ${(ra as any).criticalCount} critical items`, impact: 'Prevent stockouts', deadline: 'Today' },
      { priority: 'P2', action: 'Run AI forecast for all items', impact: 'Improve inventory accuracy', deadline: 'This week' },
      { priority: 'P3', action: 'Review reorder points for slow-moving items', impact: 'Reduce overstock', deadline: 'This month' },
    ],
    urgency: (ra as any).criticalCount > 5 ? 'immediate' : 'this_week',
    estimatedImpact: `Prevent stockouts in ${(ra as any).criticalCount} items`,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGENT 6 — ReportWriter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function agentReportWriter(
  all: {
    dc: any; ta: any; ra: any; fe: any; rec: any;
  },
  runId: string,
  tenantId: string
) {
  const ordersNeeded = (all.fe as any).forecasts?.filter((f: any) => f.shouldOrder).length ?? 0;

  const prompt = `You are ReportWriter, an executive summary agent for a store owner.

COMPLETE PIPELINE RESULTS:
- Total items analyzed: ${all.dc.totalItems}
- Items below reorder point: ${all.dc.totalAlerts}
- Inventory health: ${(all.ta as any).overallHealth}
- Risk score: ${(all.ra as any).riskScore}/100
- Items needing reorder: ${ordersNeeded}
- Estimated reorder spend: ₹${(all.fe as any).totalOrderValue ?? 0}
- Action urgency: ${(all.rec as any).urgency}
- Key insight: ${(all.ta as any).insights?.[0] ?? 'N/A'}
- Risk summary: ${(all.ra as any).summary}

Write a 3-sentence executive summary for the store owner. Return ONLY valid JSON (no markdown):
{
  "executiveSummary": "3-sentence plain-English summary",
  "keyMetrics": {
    "healthScore": 75,
    "criticalItems": 3,
    "reorderItems": 5,
    "estimatedSpend": 15000
  },
  "nextSteps": ["string", "string", "string"]
}`;

  return callClaude(prompt, 'ReportWriter', runId, tenantId, {
    executiveSummary: `Your store has ${all.dc.totalItems} active items with ${all.dc.totalAlerts} below the reorder point. The overall inventory health is ${(all.ta as any).overallHealth}. Immediate action is recommended for ${(all.ra as any).criticalCount} critical items.`,
    keyMetrics: {
      healthScore: Math.max(0, 100 - (all.ra as any).riskScore),
      criticalItems: (all.ra as any).criticalCount ?? all.dc.totalAlerts,
      reorderItems: ordersNeeded,
      estimatedSpend: (all.fe as any).totalOrderValue ?? 0,
    },
    nextSteps: ['Reorder critical items immediately', 'Run AI forecast for full inventory', 'Review and adjust reorder points'],
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PIPELINE ORCHESTRATOR
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export interface AgentStep {
  name: string;
  status: 'success' | 'error';
  latencyMs: number;
  outputSummary: string;
}

export interface PipelineResult {
  runId: string;
  status: 'completed' | 'failed';
  agents: AgentStep[];
  result: {
    collector: any;
    trend: any;
    risk: any;
    forecast: any;
    recommendation: any;
    report: any;
  };
  totalTokens: number;
  durationMs: number;
}

export async function runAIPipeline(
  storeId: string,
  storeName: string,
  tenantId: string,
  triggeredBy?: string
): Promise<PipelineResult> {
  const runId = crypto.randomUUID();
  const startedAt = Date.now();

  await dbQuery(
    `INSERT INTO ai_pipeline_runs (id, tenant_id, store_id, store_name, triggered_by, status, agents_total)
     VALUES ($1,$2,$3,$4,$5,'running',6)`,
    [runId, tenantId, storeId, storeName, triggeredBy ?? null]
  );

  const agents: AgentStep[] = [];

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      const out = await fn();
      agents.push({ name, status: 'success', latencyMs: Date.now() - t0, outputSummary: Object.keys(out as any).join(', ') });
      await dbQuery(`UPDATE ai_pipeline_runs SET agents_completed = agents_completed + 1 WHERE id = $1`, [runId]);
      return out;
    } catch (err: any) {
      agents.push({ name, status: 'error', latencyMs: Date.now() - t0, outputSummary: err.message });
      throw err;
    }
  };

  try {
    const dc  = await step('DataCollector',       () => agentDataCollector(storeId));
    const ta  = await step('TrendAnalyzer',       () => agentTrendAnalyzer(dc, runId, tenantId));
    const ra  = await step('RiskAssessor',        () => agentRiskAssessor(dc, ta, runId, tenantId));
    const fe  = await step('ForecastEngine',      () => agentForecastEngine(dc, ta, ra, runId, tenantId));
    const rec = await step('RecommendationAgent', () => agentRecommendationAgent(ra, fe, runId, tenantId));
    const rep = await step('ReportWriter',        () => agentReportWriter({ dc, ta, ra, fe, rec }, runId, tenantId));

    const [tokenRow] = await dbQuery<{ t: string }>(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0)::int AS t FROM ai_usage_logs WHERE pipeline_run_id = $1`,
      [runId]
    );
    const totalTokens = parseInt(tokenRow?.t ?? '0');

    const result = { collector: dc, trend: ta, risk: ra, forecast: fe, recommendation: rec, report: rep };

    await dbQuery(
      `UPDATE ai_pipeline_runs SET status='completed', total_tokens=$1, result=$2, completed_at=NOW() WHERE id=$3`,
      [totalTokens, JSON.stringify(result), runId]
    );

    return { runId, status: 'completed', agents, result, totalTokens, durationMs: Date.now() - startedAt };
  } catch (err: any) {
    await dbQuery(
      `UPDATE ai_pipeline_runs SET status='failed', error=$1, completed_at=NOW() WHERE id=$2`,
      [err.message, runId]
    );
    throw err;
  }
}

// ── AI usage summary for superadmin report ────────────────────
export async function getAIUsageSummary(range: 'daily' | 'weekly' | 'monthly') {
  const interval = range === 'daily' ? '1 day' : range === 'weekly' ? '7 days' : '30 days';

  const [totals, byFeature, trend, recentLogs] = await Promise.all([
    dbQuery<any>(
      `SELECT
         COUNT(*)::int                                  AS total_calls,
         COALESCE(SUM(prompt_tokens+completion_tokens),0)::int AS total_tokens,
         COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0)::int AS success_count,
         COALESCE(SUM(latency_ms),0)::int               AS total_latency
       FROM ai_usage_logs WHERE created_at > NOW() - $1::interval`,
      [interval]
    ),
    dbQuery<any>(
      `SELECT feature,
              COUNT(*)::int                                         AS calls,
              COALESCE(SUM(prompt_tokens+completion_tokens),0)::int AS tokens
       FROM ai_usage_logs WHERE created_at > NOW() - $1::interval
       GROUP BY feature ORDER BY calls DESC`,
      [interval]
    ),
    dbQuery<any>(
      `SELECT created_at::date::text AS date,
              COUNT(*)::int          AS calls,
              COALESCE(SUM(prompt_tokens+completion_tokens),0)::int AS tokens
       FROM ai_usage_logs WHERE created_at > NOW() - $1::interval
       GROUP BY created_at::date ORDER BY date`,
      [interval]
    ),
    dbQuery<any>(
      `SELECT id, feature, agent_name, model, prompt_tokens, completion_tokens,
              latency_ms, status, error_msg, created_at::text
       FROM ai_usage_logs
       ORDER BY created_at DESC LIMIT 50`
    ),
  ]);

  const t = totals[0] ?? {};
  const totalCalls = t.total_calls ?? 0;
  const successCount = t.success_count ?? 0;
  const totalTokens = t.total_tokens ?? 0;
  // Estimated cost: Haiku ~$0.80/MTok input + $4/MTok output — blended ≈ $1.5/MTok
  const estimatedCostUsd = +(totalTokens * 0.0000015).toFixed(4);

  return {
    totalCalls,
    totalTokens,
    estimatedCostUsd,
    successRate: totalCalls > 0 ? +((successCount / totalCalls) * 100).toFixed(1) : 100,
    avgLatencyMs: totalCalls > 0 ? Math.round(t.total_latency / totalCalls) : 0,
    byFeature,
    trend,
    recentLogs,
  };
}

// ── Pipeline run history ──────────────────────────────────────
export async function getPipelineRuns(limit = 20) {
  return dbQuery<any>(
    `SELECT id, tenant_id, store_id, store_name, status,
            agents_completed, agents_total, total_tokens,
            error, started_at::text, completed_at::text,
            EXTRACT(EPOCH FROM (completed_at - started_at))::int AS duration_s
     FROM ai_pipeline_runs
     ORDER BY started_at DESC LIMIT $1`,
    [limit]
  );
}

export async function getPipelineRun(runId: string) {
  const rows = await dbQuery<any>(
    `SELECT id, tenant_id, store_id, store_name, status,
            agents_completed, agents_total, total_tokens,
            result, error, started_at::text, completed_at::text,
            EXTRACT(EPOCH FROM (completed_at - started_at))::int AS duration_s
     FROM ai_pipeline_runs WHERE id = $1`,
    [runId]
  );
  return rows[0] ?? null;
}
