// ============================================================
// TEAFACTORY360 — SCHEDULED BACKGROUND JOBS
// ============================================================
// Two deterministic (non-AI) WhatsApp jobs, matching the marketing spec's
// "Home & overnight alerts" (daily digest) and "Grower payment via
// WhatsApp" (weekly) claims. Deliberately NOT AI-generated like the
// manual /ai/payment-summary flow — running Claude per grower per tenant
// on an unattended schedule is expensive and adds a failure mode nobody
// is watching; these use plain templates instead, same numbers a human
// would see on /tea/notifications or the grower ledger.
//
// Scheduling follows the same setInterval-tick + idempotency-guard
// pattern already used for SafeRide360's background jobs
// (background.service.ts) rather than a new cron dependency: each tick
// checks whether "now" (IST) falls in the target window, and claims an
// atomic row in tea_job_runs so a tenant is only actually processed once
// per real cadence even if the tick fires several times inside the window.

import { query } from '../../config/db';
import { logger } from '../../config/logger';
import { sendWhatsAppText, normalizeWhatsAppPhone } from '../../utils/whatsapp';

const IST_TZ = 'Asia/Kolkata';

function istNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: IST_TZ }));
}

// One row per tenant per run_key; returns true only if this call is the
// one that actually claimed it (i.e. safe to proceed and send).
async function claimJobRun(jobKey: string, tenantId: string, runKey: string): Promise<boolean> {
  const rows = await query<any>(
    `INSERT INTO tea_job_runs (job_key, tenant_id, run_key) VALUES ($1,$2,$3)
     ON CONFLICT (job_key, tenant_id, run_key) DO NOTHING RETURNING 1`,
    [jobKey, tenantId, runKey]
  );
  return rows.length > 0;
}

async function activeTeaTenants(): Promise<{ tenant_id: string }[]> {
  return query<any>(
    `SELECT DISTINCT t.id AS tenant_id
     FROM tenants t
     JOIN tenant_industries ti ON ti.tenant_id = t.id
     JOIN industry_configs ic ON ic.id = ti.industry_id AND ic.industry_id = 'tea'
     WHERE t.is_active = TRUE`
  );
}

async function ownerPhone(tenantId: string): Promise<string | null> {
  const owner = await query<any>(
    `SELECT phone FROM users WHERE tenant_id=$1 AND role='owner' AND phone IS NOT NULL AND phone<>'' LIMIT 1`,
    [tenantId]
  );
  return owner[0]?.phone || null;
}

// ── Daily morning digest — "Home & overnight alerts" (~7:30 AM IST) ──
// Same numbers as GET /tea/notifications, pushed instead of pulled.
export async function runTeaDailyDigestJob() {
  try {
    const now = istNow();
    if (now.getHours() !== 7) return; // only inside the 7am IST hour
    const runKey = now.toISOString().slice(0, 10); // YYYY-MM-DD, once per calendar day

    const tenants = await activeTeaTenants();
    for (const { tenant_id } of tenants) {
      const claimed = await claimJobRun('daily_digest', tenant_id, runKey);
      if (!claimed) continue;

      const phone = await ownerPhone(tenant_id);
      if (!phone) continue;

      const [unpaid] = await query<any>(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(net_payable), 0) AS amount
         FROM tea_grower_settlements WHERE tenant_id=$1 AND paid=FALSE`,
        [tenant_id]
      );
      const [pendingDispatch] = await query<any>(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_kg), 0) AS kg
         FROM tea_collection_batches WHERE tenant_id=$1 AND status='pending_dispatch'`,
        [tenant_id]
      );
      const overdueMaint = await query<any>(
        `SELECT COUNT(*)::int AS count FROM tea_vehicle_maintenance
         WHERE tenant_id=$1 AND due_date IS NOT NULL AND due_date < CURRENT_DATE`,
        [tenant_id]
      );

      const lines = ['Good morning! Your TeaFactory360 overnight summary:'];
      if (unpaid?.count > 0) {
        lines.push(`- ${unpaid.count} grower payment${unpaid.count > 1 ? 's' : ''} pending, ₹${Math.round(parseFloat(unpaid.amount))} total.`);
      }
      if (pendingDispatch?.count > 0) {
        lines.push(`- ${pendingDispatch.count} collection batch${pendingDispatch.count > 1 ? 'es' : ''} waiting to be dispatched (${parseFloat(pendingDispatch.kg).toFixed(0)} kg).`);
      }
      if (overdueMaint[0]?.count > 0) {
        lines.push(`- ${overdueMaint[0].count} vehicle service${overdueMaint[0].count > 1 ? 's' : ''} overdue.`);
      }
      if (lines.length === 1) lines.push('- All clear — nothing pending. Have a great day!');

      const result = await sendWhatsAppText(normalizeWhatsAppPhone(phone), lines.join('\n'));
      if (!result.sent) logger.warn(`[TeaJob:dailyDigest] tenant=${tenant_id} not sent: ${result.error || result.skipped}`);
    }
  } catch (e: any) {
    logger.error('[TeaJob:dailyDigest] Job failed:', e.message);
  }
}

// ── Weekly grower payment notice — "Grower payment via WhatsApp" ──
// Notifies growers with an unpaid settlement once a week (Monday, 9am
// IST window) using the plain settlement numbers — the richer,
// anomaly-aware AI wording stays available as the existing manual
// /ai/payment-summary flow for whoever wants to review before sending.
export async function runTeaWeeklyGrowerPaymentJob() {
  try {
    const now = istNow();
    if (now.getDay() !== 1 || now.getHours() !== 9) return; // Monday, 9am IST hour only
    const mondayKey = now.toISOString().slice(0, 10);

    const tenants = await activeTeaTenants();
    for (const { tenant_id } of tenants) {
      const claimed = await claimJobRun('weekly_grower_payment', tenant_id, mondayKey);
      if (!claimed) continue;

      const settlements = await query<any>(
        `SELECT s.*, g.name AS grower_name, g.phone AS grower_phone
         FROM tea_grower_settlements s JOIN tea_growers g ON g.id = s.grower_id
         WHERE s.tenant_id=$1 AND s.paid=FALSE AND g.phone IS NOT NULL AND g.phone<>''`,
        [tenant_id]
      );

      for (const s of settlements) {
        const msg = `Hello ${s.grower_name}, your tea collection settlement for ${new Date(s.week_start_date).toLocaleDateString('en-IN')} - ${new Date(s.week_end_date).toLocaleDateString('en-IN')}: ${s.total_kg} kg, net payable ₹${Number(s.net_payable).toFixed(0)}. Contact us if this doesn't look right.`;
        const result = await sendWhatsAppText(normalizeWhatsAppPhone(s.grower_phone), msg);
        if (!result.sent) logger.warn(`[TeaJob:weeklyPayment] tenant=${tenant_id} grower=${s.grower_id} not sent: ${result.error || result.skipped}`);
      }
    }
  } catch (e: any) {
    logger.error('[TeaJob:weeklyPayment] Job failed:', e.message);
  }
}
