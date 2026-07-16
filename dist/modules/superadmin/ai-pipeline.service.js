"use strict";
/**
 * AI Agent Pipeline — Sequential multi-agent demand analysis
 *
 * Agents run in order, each receiving the structured output of all prior agents:
 *   DataCollector → TrendAnalyzer → RiskAssessor → ForecastEngine → RecommendationAgent → ReportWriter
 *
 * Every Claude call is logged to ai_usage_logs for the superadmin AI Usage report.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logAIUsage = logAIUsage;
exports.runAIPipeline = runAIPipeline;
exports.getAIUsageSummary = getAIUsageSummary;
exports.getPipelineRuns = getPipelineRuns;
exports.getPipelineRun = getPipelineRun;
const db_1 = require("../../config/db");
const logger_1 = require("../../config/logger");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const gemini_service_1 = require("../auth/gemini.service");
const MODEL = 'claude-haiku-4-5-20251001';
function mkClient() {
    return new sdk_1.default({ apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY });
}
// ── Shared: log every AI call ─────────────────────────────────
async function logAIUsage(params) {
    try {
        await (0, db_1.query)(`INSERT INTO ai_usage_logs
         (feature, agent_name, pipeline_run_id, model, prompt_tokens, completion_tokens,
          latency_ms, status, error_msg, tenant_id, store_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
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
        ]);
    }
    catch (e) {
        logger_1.logger.warn('logAIUsage failed:', e.message);
    }
}
// ── AI helper: call + log + return parsed JSON (supports Claude and Gemini) ──
async function callClaude(prompt, agentName, pipelineRunId, tenantId, fallback) {
    const t0 = Date.now();
    let modelUsed = MODEL;
    let text = '';
    let promptTokens = 0;
    let completionTokens = 0;
    if (process.env.AI_PROVIDER === 'gemini') {
        try {
            const geminiRes = await (0, gemini_service_1.callGemini)({
                prompt: prompt,
                maxTokens: 700,
                responseMimeType: 'application/json',
            });
            modelUsed = geminiRes.model;
            text = geminiRes.text;
            promptTokens = geminiRes.inputTokens;
            completionTokens = geminiRes.outputTokens;
            const ms = Date.now() - t0;
            await logAIUsage({
                feature: 'pipeline',
                agentName,
                pipelineRunId,
                model: modelUsed,
                promptTokens,
                completionTokens,
                latencyMs: ms,
                status: 'success',
                tenantId,
            });
        }
        catch (err) {
            await logAIUsage({
                feature: 'pipeline',
                agentName,
                pipelineRunId,
                model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
                promptTokens: 0,
                completionTokens: 0,
                latencyMs: Date.now() - t0,
                status: 'error',
                errorMsg: err.message,
                tenantId,
            });
            logger_1.logger.warn(`[Pipeline:${agentName}] Gemini call failed: ${err.message}`);
            return fallback;
        }
    }
    else {
        const client = mkClient();
        try {
            const msg = await client.messages.create({
                model: MODEL,
                max_tokens: 700,
                messages: [{ role: 'user', content: prompt }],
            });
            modelUsed = MODEL;
            text = msg.content[0].text ?? '{}';
            promptTokens = msg.usage.input_tokens;
            completionTokens = msg.usage.output_tokens;
            const ms = Date.now() - t0;
            await logAIUsage({
                feature: 'pipeline',
                agentName,
                pipelineRunId,
                model: modelUsed,
                promptTokens,
                completionTokens,
                latencyMs: ms,
                status: 'success',
                tenantId,
            });
        }
        catch (err) {
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
            logger_1.logger.warn(`[Pipeline:${agentName}] Claude call failed: ${err.message}`);
            return fallback;
        }
    }
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : fallback;
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGENT 1 — DataCollector (DB only, no Claude)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function agentDataCollector(storeId) {
    const [items, recentForecasts] = await Promise.all([
        (0, db_1.query)(`SELECT i.id, i.name, i.sku, c.name AS category, i.selling_price AS unit_price,
              i.current_stock, i.reorder_level AS reorder_point, i.is_active
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
       WHERE i.store_id = $1 AND i.is_active = TRUE
       ORDER BY i.name LIMIT 60`, [storeId]),
        (0, db_1.query)(`SELECT item_id, predicted_qty_30d, confidence_pct, order_needed,
              order_qty, risk_level, created_at::text
       FROM ai_forecasts
       WHERE store_id = $1
       ORDER BY created_at DESC LIMIT 40`, [storeId]),
    ]);
    const stockAlerts = items.filter((i) => parseFloat(i.current_stock) <= parseFloat(i.reorder_point ?? 0));
    const categories = [...new Set(items.map((i) => i.category).filter(Boolean))];
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
async function agentTrendAnalyzer(dc, runId, tenantId) {
    const itemSample = dc.items.slice(0, 20).map((i) => {
        const f = dc.recentForecasts.find((r) => r.item_id === i.id);
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
        trends: dc.categories.map((c) => ({ category: c, direction: 'stable', change_pct: 0, confidence: 50, note: 'Insufficient data' })),
        overallHealth: dc.totalAlerts > dc.totalItems * 0.3 ? 'warning' : 'good',
        insights: ['Inventory levels are being monitored', 'Set up regular forecasting for better trends', 'Add more historical data for accurate analysis'],
    });
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGENT 3 — RiskAssessor
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function agentRiskAssessor(dc, ta, runId, tenantId) {
    const criticalItems = dc.stockAlerts.slice(0, 12).map((i) => `${i.name} (stock:${i.current_stock}, reorder_at:${i.reorder_point ?? 0})`).join('\n') || 'None';
    const decliningCats = ta.trends
        ?.filter((t) => t.direction === 'declining')
        .map((t) => t.category)
        .join(', ') || 'none';
    const prompt = `You are RiskAssessor, an inventory risk scoring agent.

PREVIOUS AGENT OUTPUT (TrendAnalyzer):
Overall health: ${ta.overallHealth}
Key insights: ${ta.insights?.join(' | ')}
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
        risks: dc.stockAlerts.slice(0, 5).map((i) => ({
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
async function agentForecastEngine(dc, ta, ra, runId, tenantId) {
    const highRisk = ra.risks
        ?.filter((r) => r.severity === 'high')
        .map((r) => r.itemName)
        .slice(0, 8) || [];
    const priorityItems = dc.items
        .filter((i) => highRisk.includes(i.name) || parseFloat(i.current_stock) <= parseFloat(i.reorder_point ?? 0))
        .slice(0, 15)
        .map((i) => `${i.name} | price:₹${i.unit_price ?? 0} | stock:${i.current_stock} | reorder_qty:${i.reorder_qty ?? 10}`)
        .join('\n') || dc.items.slice(0, 10).map((i) => `${i.name} | price:₹${i.unit_price ?? 0} | stock:${i.current_stock} | reorder_qty:${i.reorder_qty ?? 10}`).join('\n');
    const prompt = `You are ForecastEngine, a 30-day demand forecasting agent.

PREVIOUS AGENT OUTPUTS:
Health: ${ta.overallHealth} | Risk score: ${ra.riskScore}/100
Critical items: ${ra.criticalCount}

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
        forecasts: dc.stockAlerts.slice(0, 8).map((i) => ({
            itemName: i.name,
            predicted30d: Math.max(1, parseFloat(i.reorder_qty ?? 10)),
            confidence: 60,
            shouldOrder: true,
            orderQty: parseFloat(i.reorder_qty ?? 10),
            estimatedCost: parseFloat(i.unit_price ?? 0) * parseFloat(i.reorder_qty ?? 10),
        })),
        totalOrderValue: dc.stockAlerts.reduce((s, i) => s + parseFloat(i.unit_price ?? 0) * parseFloat(i.reorder_qty ?? 10), 0),
        forecastConfidence: 60,
    });
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGENT 5 — RecommendationAgent
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function agentRecommendationAgent(ra, fe, runId, tenantId) {
    const ordersNeeded = fe.forecasts?.filter((f) => f.shouldOrder) ?? [];
    const prompt = `You are RecommendationAgent, an inventory action prioritization agent.

PREVIOUS AGENT OUTPUTS:
Risk score: ${ra.riskScore}/100 | Critical items: ${ra.criticalCount}
Risk summary: ${ra.summary}
Items needing reorder: ${ordersNeeded.length}
Total order value: ₹${fe.totalOrderValue ?? 0}
Forecast confidence: ${fe.forecastConfidence ?? 0}%

TOP RISKS: ${ra.risks?.slice(0, 5).map((r) => `${r.itemName}(${r.severity}): ${r.action}`).join(' | ') || 'none'}
TOP ORDERS: ${ordersNeeded.slice(0, 5).map((f) => `${f.itemName}(qty:${f.orderQty},₹${f.estimatedCost})`).join(' | ') || 'none'}

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
            { priority: 'P1', action: `Reorder ${ra.criticalCount} critical items`, impact: 'Prevent stockouts', deadline: 'Today' },
            { priority: 'P2', action: 'Run AI forecast for all items', impact: 'Improve inventory accuracy', deadline: 'This week' },
            { priority: 'P3', action: 'Review reorder points for slow-moving items', impact: 'Reduce overstock', deadline: 'This month' },
        ],
        urgency: ra.criticalCount > 5 ? 'immediate' : 'this_week',
        estimatedImpact: `Prevent stockouts in ${ra.criticalCount} items`,
    });
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGENT 6 — ReportWriter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function agentReportWriter(all, runId, tenantId) {
    const ordersNeeded = all.fe.forecasts?.filter((f) => f.shouldOrder).length ?? 0;
    const prompt = `You are ReportWriter, an executive summary agent for a store owner.

COMPLETE PIPELINE RESULTS:
- Total items analyzed: ${all.dc.totalItems}
- Items below reorder point: ${all.dc.totalAlerts}
- Inventory health: ${all.ta.overallHealth}
- Risk score: ${all.ra.riskScore}/100
- Items needing reorder: ${ordersNeeded}
- Estimated reorder spend: ₹${all.fe.totalOrderValue ?? 0}
- Action urgency: ${all.rec.urgency}
- Key insight: ${all.ta.insights?.[0] ?? 'N/A'}
- Risk summary: ${all.ra.summary}

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
        executiveSummary: `Your store has ${all.dc.totalItems} active items with ${all.dc.totalAlerts} below the reorder point. The overall inventory health is ${all.ta.overallHealth}. Immediate action is recommended for ${all.ra.criticalCount} critical items.`,
        keyMetrics: {
            healthScore: Math.max(0, 100 - all.ra.riskScore),
            criticalItems: all.ra.criticalCount ?? all.dc.totalAlerts,
            reorderItems: ordersNeeded,
            estimatedSpend: all.fe.totalOrderValue ?? 0,
        },
        nextSteps: ['Reorder critical items immediately', 'Run AI forecast for full inventory', 'Review and adjust reorder points'],
    });
}
async function runAIPipeline(storeId, storeName, tenantId, triggeredBy) {
    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    await (0, db_1.query)(`INSERT INTO ai_pipeline_runs (id, tenant_id, store_id, store_name, triggered_by, status, agents_total)
     VALUES ($1,$2,$3,$4,$5,'running',6)`, [runId, tenantId, storeId, storeName, triggeredBy ?? null]);
    const agents = [];
    const step = async (name, fn) => {
        const t0 = Date.now();
        try {
            const out = await fn();
            agents.push({ name, status: 'success', latencyMs: Date.now() - t0, outputSummary: Object.keys(out).join(', ') });
            await (0, db_1.query)(`UPDATE ai_pipeline_runs SET agents_completed = agents_completed + 1 WHERE id = $1`, [runId]);
            return out;
        }
        catch (err) {
            agents.push({ name, status: 'error', latencyMs: Date.now() - t0, outputSummary: err.message });
            throw err;
        }
    };
    try {
        const dc = await step('DataCollector', () => agentDataCollector(storeId));
        const ta = await step('TrendAnalyzer', () => agentTrendAnalyzer(dc, runId, tenantId));
        const ra = await step('RiskAssessor', () => agentRiskAssessor(dc, ta, runId, tenantId));
        const fe = await step('ForecastEngine', () => agentForecastEngine(dc, ta, ra, runId, tenantId));
        const rec = await step('RecommendationAgent', () => agentRecommendationAgent(ra, fe, runId, tenantId));
        const rep = await step('ReportWriter', () => agentReportWriter({ dc, ta, ra, fe, rec }, runId, tenantId));
        const [tokenRow] = await (0, db_1.query)(`SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0)::int AS t FROM ai_usage_logs WHERE pipeline_run_id = $1`, [runId]);
        const totalTokens = parseInt(tokenRow?.t ?? '0');
        const result = { collector: dc, trend: ta, risk: ra, forecast: fe, recommendation: rec, report: rep };
        await (0, db_1.query)(`UPDATE ai_pipeline_runs SET status='completed', total_tokens=$1, result=$2, completed_at=NOW() WHERE id=$3`, [totalTokens, JSON.stringify(result), runId]);
        return { runId, status: 'completed', agents, result, totalTokens, durationMs: Date.now() - startedAt };
    }
    catch (err) {
        await (0, db_1.query)(`UPDATE ai_pipeline_runs SET status='failed', error=$1, completed_at=NOW() WHERE id=$2`, [err.message, runId]);
        throw err;
    }
}
// ── AI usage summary for superadmin report ────────────────────
async function getAIUsageSummary(range) {
    const interval = range === 'daily' ? '1 day' : range === 'weekly' ? '7 days' : '30 days';
    const [totals, byFeature, trend, recentLogs] = await Promise.all([
        (0, db_1.query)(`SELECT
         COUNT(*)::int                                  AS total_calls,
         COALESCE(SUM(prompt_tokens+completion_tokens),0)::int AS total_tokens,
         COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0)::int AS success_count,
         COALESCE(SUM(latency_ms),0)::int               AS total_latency
       FROM ai_usage_logs WHERE created_at > NOW() - $1::interval`, [interval]),
        (0, db_1.query)(`SELECT feature,
              COUNT(*)::int                                         AS calls,
              COALESCE(SUM(prompt_tokens+completion_tokens),0)::int AS tokens
       FROM ai_usage_logs WHERE created_at > NOW() - $1::interval
       GROUP BY feature ORDER BY calls DESC`, [interval]),
        (0, db_1.query)(`SELECT created_at::date::text AS date,
              COUNT(*)::int          AS calls,
              COALESCE(SUM(prompt_tokens+completion_tokens),0)::int AS tokens
       FROM ai_usage_logs WHERE created_at > NOW() - $1::interval
       GROUP BY created_at::date ORDER BY date`, [interval]),
        (0, db_1.query)(`SELECT id, feature, agent_name, model, prompt_tokens, completion_tokens,
              latency_ms, status, error_msg, created_at::text
       FROM ai_usage_logs
       ORDER BY created_at DESC LIMIT 50`),
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
async function getPipelineRuns(limit = 20) {
    return (0, db_1.query)(`SELECT id, tenant_id, store_id, store_name, status,
            agents_completed, agents_total, total_tokens,
            error, started_at::text, completed_at::text,
            EXTRACT(EPOCH FROM (completed_at - started_at))::int AS duration_s
     FROM ai_pipeline_runs
     ORDER BY started_at DESC LIMIT $1`, [limit]);
}
async function getPipelineRun(runId) {
    const rows = await (0, db_1.query)(`SELECT id, tenant_id, store_id, store_name, status,
            agents_completed, agents_total, total_tokens,
            result, error, started_at::text, completed_at::text,
            EXTRACT(EPOCH FROM (completed_at - started_at))::int AS duration_s
     FROM ai_pipeline_runs WHERE id = $1`, [runId]);
    return rows[0] ?? null;
}
