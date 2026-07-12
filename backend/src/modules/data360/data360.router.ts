// ============================================================
// data360.router.ts — Nexus Flow RPA data pipeline API routes
// Mounted at /v1/data360 in app.ts
// Auth: own JWT scope='data360', same secret as main app
//
// Pipeline: ingest (client-parsed rows) -> validation agent (server-side
// regex/business rules) -> human approval gate -> distribution
// (file export / cloud storage via S3 / RPA portal — RPA execution is
// NOT wired to a real browser here; see distribute handler for why).
// ============================================================
import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import * as XLSX from 'xlsx';
import { query, queryOne, withTransaction, runMigrations } from '../../config/db';

export const data360Router = Router();

// ── Config ───────────────────────────────────────────────────
const JWT_SECRET: Secret = (process.env.JWT_SECRET || 'dev-secret-change-this') as Secret;
const signOptions: SignOptions = { expiresIn: 8 * 3600 };

// ── Helpers ──────────────────────────────────────────────────
function ok(res: Response, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: Response, message: string, status = 400) {
  res.status(status).json({ success: false, error: message, timestamp: new Date().toISOString() });
}
function makeToken(user: any) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, scope: 'data360' },
    JWT_SECRET,
    signOptions
  );
}

// ── Auth middleware ───────────────────────────────────────────
interface D360Req extends Request { d360User?: any; }

function data360Auth(req: D360Req, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
  try {
    const decoded: any = jwt.verify(header.slice(7), JWT_SECRET);
    if (decoded.scope !== 'data360') { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
    req.d360User = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Token expired or invalid' });
  }
}

// ── STATUS (diagnostic) ───────────────────────────────────────
data360Router.get('/status', async (_req, res) => {
  try {
    const tables = await query<any>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'data360%' ORDER BY tablename`,
      []
    );
    const migrations = await query<any>(`SELECT name, run_at FROM _migrations WHERE name LIKE '%data360%' ORDER BY name`, []);
    ok(res, { tables: tables.map((t: any) => t.tablename), migrations });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── RUN MIGRATIONS (admin debug) ─────────────────────────────
data360Router.post('/admin/run-migrations', async (req, res) => {
  if (req.headers['x-admin-key'] !== (process.env.ADMIN_SECRET || 'c360-admin')) {
    res.status(403).json({ success: false, error: 'Forbidden' }); return;
  }
  try {
    await runMigrations();
    ok(res, { message: 'Migrations complete' });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── REGISTER ─────────────────────────────────────────────────
data360Router.post('/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) { fail(res, 'name, email and password are required'); return; }
    const emailLc = email.toLowerCase().trim();
    const existing = await queryOne<any>('SELECT id FROM data360_users WHERE email=$1', [emailLc]);
    if (existing) { fail(res, 'Email already registered'); return; }
    const hash = await bcrypt.hash(password, 10);
    const [user] = await query<any>(
      `INSERT INTO data360_users (name, email, password_hash)
       VALUES ($1,$2,$3)
       RETURNING id, name, email, role, created_at`,
      [name, emailLc, hash]
    );
    const token = makeToken(user);
    ok(res, { token, user }, 201);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── LOGIN ─────────────────────────────────────────────────────
data360Router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) { fail(res, 'email and password are required'); return; }
    const user = await queryOne<any>(
      `SELECT id, name, email, password_hash, role FROM data360_users WHERE email=$1 AND is_active=TRUE`,
      [email.toLowerCase().trim()]
    );
    if (!user) { fail(res, 'Invalid email or password', 401); return; }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) { fail(res, 'Invalid email or password', 401); return; }
    const { password_hash: _, ...safeUser } = user;
    const token = makeToken(safeUser);
    ok(res, { token, user: safeUser });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

data360Router.get('/auth/me', data360Auth, async (req: D360Req, res) => {
  try {
    const user = await queryOne<any>('SELECT id, name, email, role, created_at FROM data360_users WHERE id=$1', [req.d360User.sub]);
    if (!user) { fail(res, 'User not found', 404); return; }
    ok(res, user);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── VALIDATION AGENT ───────────────────────────────────────────
// Mirrors the spec's run_validation_agent(): email regex + amount sanity
// check, producing a percentage-confidence verdict string.
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

interface IngestRow {
  source_type?: string;
  extracted_entity?: string;
  target_field_a?: string; // amount
  target_field_b?: string; // email
  raw_snippet?: string;
}

function validateRow(row: IngestRow): { verdict: string; level: 'ok' | 'warning' | 'critical'; requiresReview: boolean } {
  const email = (row.target_field_b || '').trim();
  const amountRaw = row.target_field_a;
  const amount = parseFloat(String(amountRaw ?? '').replace(/[^0-9.-]/g, ''));

  if (!email || !EMAIL_RE.test(email)) {
    const confidence = Math.floor(30 + Math.random() * 20);
    return { verdict: `${confidence}% Error: Bad Email`, level: 'critical', requiresReview: true };
  }
  if (amountRaw === undefined || amountRaw === null || String(amountRaw).trim() === '' || Number.isNaN(amount) || amount <= 0) {
    const confidence = Math.floor(75 + Math.random() * 15);
    return { verdict: `${confidence}% Review Suggested`, level: 'warning', requiresReview: true };
  }
  if (!row.extracted_entity || !row.extracted_entity.trim()) {
    const confidence = Math.floor(75 + Math.random() * 15);
    return { verdict: `${confidence}% Review Suggested`, level: 'warning', requiresReview: true };
  }
  const confidence = Math.floor(94 + Math.random() * 6);
  return { verdict: `${confidence}% Match [OK]`, level: 'ok', requiresReview: false };
}

// ── CREATE BATCH (ingest) ──────────────────────────────────────
// Frontend parses the source file (Excel/PDF/screenshot OCR/voice) client
// side into a flat row array and posts it here for real server-side
// validation + persistence.
data360Router.post('/batches', data360Auth, async (req: D360Req, res) => {
  try {
    const { name, source_channel, rows } = req.body as { name: string; source_channel: string; rows: IngestRow[] };
    if (!name?.trim()) { fail(res, 'name is required'); return; }
    if (!Array.isArray(rows) || rows.length === 0) { fail(res, 'rows must be a non-empty array'); return; }

    const result = await withTransaction(async (client) => {
      const batchRes = await client.query(
        `INSERT INTO data360_batches (user_id, name, source_channel, total_rows)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.d360User.sub, name.trim(), source_channel || 'excel', rows.length]
      );
      const batch = batchRes.rows[0];

      let flagged = 0;
      const insertedRows: any[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const v = validateRow(row);
        if (v.requiresReview) flagged++;
        const rowRes = await client.query(
          `INSERT INTO data360_rows
             (batch_id, row_index, source_type, extracted_entity, target_field_a, target_field_b,
              raw_snippet, agent_verdict, verdict_level, requires_manual_review, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING *`,
          [
            batch.id, i, row.source_type || source_channel || 'excel', row.extracted_entity || null,
            row.target_field_a ?? null, row.target_field_b ?? null, row.raw_snippet || null,
            v.verdict, v.level, v.requiresReview, v.requiresReview ? 'pending' : 'approved',
          ]
        );
        insertedRows.push(rowRes.rows[0]);
      }

      await client.query(`UPDATE data360_batches SET flagged_rows=$1, updated_at=NOW() WHERE id=$2`, [flagged, batch.id]);
      return { batch: { ...batch, flagged_rows: flagged }, rows: insertedRows };
    });

    ok(res, result, 201);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── LIST BATCHES ────────────────────────────────────────────────
data360Router.get('/batches', data360Auth, async (req: D360Req, res) => {
  try {
    const batches = await query<any>(
      `SELECT * FROM data360_batches WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.d360User.sub]
    );
    ok(res, batches);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── BATCH DETAIL + ROWS ─────────────────────────────────────────
data360Router.get('/batches/:id', data360Auth, async (req: D360Req, res) => {
  try {
    const batch = await queryOne<any>(
      `SELECT * FROM data360_batches WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.d360User.sub]
    );
    if (!batch) { fail(res, 'Batch not found', 404); return; }
    const rows = await query<any>(
      `SELECT * FROM data360_rows WHERE batch_id=$1 ORDER BY row_index ASC`,
      [batch.id]
    );
    const jobs = await query<any>(
      `SELECT * FROM data360_distribution_jobs WHERE batch_id=$1 ORDER BY created_at DESC`,
      [batch.id]
    );
    ok(res, { batch, rows, jobs });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── ROW APPROVE / REJECT / MANUAL OVERRIDE ──────────────────────
data360Router.patch('/batches/:id/rows/:rowId', data360Auth, async (req: D360Req, res) => {
  try {
    const { status, manual_override } = req.body as { status?: 'approved' | 'rejected'; manual_override?: { target_field_a?: string; target_field_b?: string } };
    const batch = await queryOne<any>('SELECT id FROM data360_batches WHERE id=$1 AND user_id=$2', [req.params.id, req.d360User.sub]);
    if (!batch) { fail(res, 'Batch not found', 404); return; }

    const sets: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (manual_override) {
      const merged: Record<string, string> = {};
      if (manual_override.target_field_a !== undefined) { sets.push(`target_field_a=$${i++}`); params.push(manual_override.target_field_a); merged.target_field_a = manual_override.target_field_a; }
      if (manual_override.target_field_b !== undefined) { sets.push(`target_field_b=$${i++}`); params.push(manual_override.target_field_b); merged.target_field_b = manual_override.target_field_b; }
      sets.push(`manual_override=$${i++}`); params.push(JSON.stringify(merged));
      sets.push(`agent_verdict=$${i++}`); params.push('OK (Manually Overridden)');
      sets.push(`verdict_level='ok'`);
      sets.push(`requires_manual_review=FALSE`);
    }
    if (status) { sets.push(`status=$${i++}`); params.push(status); }
    sets.push(`updated_at=NOW()`);

    if (sets.length === 1) { fail(res, 'Nothing to update'); return; }

    params.push(req.params.rowId, batch.id);
    const [row] = await query<any>(
      `UPDATE data360_rows SET ${sets.join(', ')} WHERE id=$${i++} AND batch_id=$${i++} RETURNING *`,
      params
    );
    if (!row) { fail(res, 'Row not found', 404); return; }

    // Refresh batch flagged_rows count + promote to 'approved' if nothing left pending
    const pending = await queryOne<any>(
      `SELECT COUNT(*)::int AS n FROM data360_rows WHERE batch_id=$1 AND requires_manual_review=TRUE AND status='pending'`,
      [batch.id]
    );
    if (pending && pending.n === 0) {
      await query(`UPDATE data360_batches SET status='approved', updated_at=NOW() WHERE id=$1 AND status='pending_approval'`, [batch.id]);
    }

    ok(res, row);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── DISTRIBUTION CONFIG + EXECUTE ────────────────────────────────
// target_type: 'file_export' | 'cloud_storage' | 'rpa_portal'
data360Router.post('/batches/:id/distribute', data360Auth, async (req: D360Req, res) => {
  try {
    const { target_type, config } = req.body as { target_type: string; config?: Record<string, any> };
    if (!['file_export', 'cloud_storage', 'rpa_portal'].includes(target_type)) { fail(res, 'Invalid target_type'); return; }

    const batch = await queryOne<any>('SELECT * FROM data360_batches WHERE id=$1 AND user_id=$2', [req.params.id, req.d360User.sub]);
    if (!batch) { fail(res, 'Batch not found', 404); return; }

    const approvedRows = await query<any>(
      `SELECT row_index, source_type, extracted_entity, target_field_a, target_field_b, agent_verdict
       FROM data360_rows WHERE batch_id=$1 AND status='approved' ORDER BY row_index ASC`,
      [batch.id]
    );
    if (approvedRows.length === 0) { fail(res, 'No approved rows to distribute — approve rows first'); return; }

    // Never persist secrets in the config we store/echo back.
    const safeConfig = { ...(config || {}) };
    if (safeConfig.password) safeConfig.password = '••••••••';
    if (safeConfig.secret_password_token) safeConfig.secret_password_token = '••••••••';

    const [job] = await query<any>(
      `INSERT INTO data360_distribution_jobs (batch_id, target_type, config, status)
       VALUES ($1,$2,$3,'pending') RETURNING *`,
      [batch.id, target_type, JSON.stringify(safeConfig)]
    );

    let status = 'pending';
    let result: Record<string, any> = {};

    if (target_type === 'file_export') {
      const ws = XLSX.utils.json_to_sheet(approvedRows.map(r => ({
        Entity: r.extracted_entity, Amount: r.target_field_a, Email: r.target_field_b,
        Source: r.source_type, Verdict: r.agent_verdict,
      })));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Approved Rows');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      status = 'completed';
      result = { file_base64: buffer.toString('base64'), file_name: `${batch.name.replace(/[^a-z0-9]+/gi, '_')}_export.xlsx`, row_count: approvedRows.length };
    } else if (target_type === 'cloud_storage') {
      const bucket = config?.bucket_name;
      const hasCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
      if (!bucket || !hasCreds) {
        status = 'failed';
        result = { error: !hasCreds ? 'AWS credentials are not configured on this server (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).' : 'bucket_name is required in config.' };
      } else {
        try {
          const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
          const s3 = new S3Client({ region: config?.region || process.env.AWS_REGION || 'us-east-1' });
          const key = `data360/${batch.id}/${Date.now()}_export.json`;
          await s3.send(new PutObjectCommand({
            Bucket: bucket, Key: key,
            Body: JSON.stringify(approvedRows, null, 2),
            ContentType: 'application/json',
          }));
          status = 'completed';
          result = { bucket, key, row_count: approvedRows.length };
        } catch (e: any) {
          status = 'failed';
          result = { error: e.message };
        }
      }
    } else if (target_type === 'rpa_portal') {
      // Live Selenium/browser-driven form submission is intentionally not
      // wired up: it cannot run reliably inside a short-lived HTTP request
      // on this deployment (no persistent headless-browser worker here).
      // The configuration is saved and the job is queued for a future
      // worker process to pick up.
      status = 'pending';
      result = { queued: true, note: 'Live browser automation is not connected in this environment. The target configuration has been saved and the job is queued.' };
    }

    const [updatedJob] = await query<any>(
      `UPDATE data360_distribution_jobs SET status=$1, result=$2, completed_at=CASE WHEN $1 != 'pending' THEN NOW() ELSE NULL END WHERE id=$3 RETURNING *`,
      [status, JSON.stringify(result), job.id]
    );

    if (status === 'completed') {
      await query(`UPDATE data360_batches SET status='distributed', updated_at=NOW() WHERE id=$1`, [batch.id]);
    }

    ok(res, updatedJob, 201);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});
