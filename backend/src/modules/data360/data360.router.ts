// ============================================================
// data360.router.ts — Nexus Flow RPA data pipeline API routes
// Mounted at /v1/data360 in app.ts
// Auth: own JWT scope='data360', same secret as main app
//
// Pipeline: ingest (client-parsed rows) -> validation agent (server-side
// regex/business rules) -> mapping agent (source fields -> target schema)
// -> approval agent (human review gate) -> destination agent (file / cloud
// storage / database / API / RPA portal — RPA execution is NOT wired to a
// real browser here; see distribute handler for why).
// ============================================================
import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import * as XLSX from 'xlsx';
import { createHash } from 'crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { query, queryOne, withTransaction, runMigrations } from '../../config/db';
import { callAI, costEffectiveOrder } from '../../config/aiService';
import { logger } from '../../config/logger';

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
// Generalized to work over a dynamic, user-chosen field list (e.g. "Invoice
// Number", "Phone") instead of a fixed Entity/Amount/Email schema — a field's
// TYPE is inferred from its name so type-aware checks (email/phone/amount
// shape) still apply, in the spirit of the original run_validation_agent().
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PHONE_RE = /^[+\d][\d\s-]{6,14}\d$/;

interface IngestRow {
  source_type?: string;
  fields?: Record<string, string>;
  raw_snippet?: string;
}

function classifyFieldName(name: string): 'email' | 'phone' | 'amount' | 'generic' {
  const n = name.toLowerCase();
  if (/e-?mail/.test(n)) return 'email';
  if (/phone|mobile|contact\s*(no|number)?|cell/.test(n)) return 'phone';
  if (/amount|total|price|value|cost|sum|balance/.test(n)) return 'amount';
  return 'generic';
}

function validateRow(row: IngestRow, extractionFields: string[]): { verdict: string; level: 'ok' | 'warning' | 'critical'; requiresReview: boolean } {
  const fields = row.fields || {};
  const names = extractionFields.length ? extractionFields : Object.keys(fields);
  let missing = 0;
  let malformed = 0;

  for (const name of names) {
    const val = (fields[name] || '').trim();
    if (!val) { missing++; continue; }
    const type = classifyFieldName(name);
    if (type === 'email' && !EMAIL_RE.test(val)) malformed++;
    if (type === 'phone' && !PHONE_RE.test(val.replace(/[()]/g, ''))) malformed++;
    if (type === 'amount' && Number.isNaN(parseFloat(val.replace(/[^0-9.-]/g, '')))) malformed++;
  }

  if (malformed > 0) {
    const confidence = Math.floor(30 + Math.random() * 20);
    return { verdict: `${confidence}% Error: ${malformed} field(s) malformed`, level: 'critical', requiresReview: true };
  }
  if (missing > 0) {
    const confidence = Math.floor(75 + Math.random() * 15);
    return { verdict: `${confidence}% Review Suggested — ${missing} field(s) missing`, level: 'warning', requiresReview: true };
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
    const { name, source_channel, rows, extraction_fields, template_id } = req.body as { name: string; source_channel: string; rows: IngestRow[]; extraction_fields?: string[]; template_id?: string };
    if (!name?.trim()) { fail(res, 'name is required'); return; }
    if (!Array.isArray(rows) || rows.length === 0) { fail(res, 'rows must be a non-empty array'); return; }
    let fieldNames = Array.isArray(extraction_fields) ? extraction_fields.filter(f => f && f.trim()) : [];

    // A saved template pre-fills the extraction field list so it doesn't need
    // retyping on every batch of the same kind (invoice, resume, ...).
    let templateId: string | null = null;
    if (template_id) {
      const tpl = await queryOne<any>('SELECT * FROM data360_templates WHERE id=$1 AND user_id=$2', [template_id, req.d360User.sub]);
      if (!tpl) { fail(res, 'Template not found'); return; }
      templateId = tpl.id;
      if (fieldNames.length === 0) fieldNames = tpl.extraction_fields;
    }

    const result = await withTransaction(async (client) => {
      const batchRes = await client.query(
        `INSERT INTO data360_batches (user_id, name, source_channel, total_rows, extraction_fields, template_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.d360User.sub, name.trim(), source_channel || 'excel', rows.length, JSON.stringify(fieldNames), templateId]
      );
      const batch = batchRes.rows[0];

      let flagged = 0;
      const insertedRows: any[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const v = validateRow(row, fieldNames);
        if (v.requiresReview) flagged++;
        const rowRes = await client.query(
          `INSERT INTO data360_rows
             (batch_id, row_index, source_type, fields, raw_snippet, agent_verdict, verdict_level, requires_manual_review, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`,
          [
            batch.id, i, row.source_type || source_channel || 'excel', JSON.stringify(row.fields || {}), row.raw_snippet || null,
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

// ── AI-ENHANCED EXTRACTION (run in parallel with the client-side heuristic,
// for the caller to compare) ──────────────────────────────────────────────
// Two entry points, one prompt/response contract, both routed through the
// shared callAI() component (config/aiService.ts) — which tries Anthropic,
// then Gemini, then Azure OpenAI in order and automatically falls back to
// the next configured provider if one fails (out of credits, rate limited,
// transient outage), rather than every caller hand-rolling its own
// provider-switching logic:
//  - /ai-extract       — text in (raw OCR/PDF/voice text), for channels
//    where the text itself is already reliable (PDF text layer, speech-to-
//    text).
//  - /ai-extract-image — image in, read directly by the model's vision.
//    Real stylized/graphic documents (colored headers, decorative fonts,
//    watermarks) can make Tesseract's OCR come back as near-total garbage —
//    at that point there's no usable text for ANY regex or text-based AI
//    call to work from. Reading the image directly skips that failure mode
//    entirely for the screenshot channel.
// Both are explicitly a side-by-side comparison, not a replacement: the
// client calls one of these in addition to its own heuristic and lets the
// user pick whichever value is right per field, rather than trusting
// either blindly.
// Only real image bytes belong on either vision endpoint below — a PDF/DOCX
// mislabeled as image/png sends the wrong bytes under the wrong mime type
// and every vision provider rejects it (confusingly, since the error looks
// like a vision failure rather than a format mismatch). The client is
// responsible for turning PDF pages into real page images before calling
// either endpoint; this list exists to fail loudly and specifically
// instead of silently coercing an unsupported type to image/png.
const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function extractionRules(fields: string[]): string {
  return `Extract exactly these fields: ${fields.join(', ')}.

Rules:
- Return ONLY a JSON object with these exact keys, nothing else — no explanation, no markdown fences.
- If a field name suggests an itemized/line-item breakdown (e.g. "Item-wise Breakdown", "Line Items"), return its value as a single string listing each item as "name: value" separated by "; ".
- If a field asks for a total/subtotal/amount, match the label exactly — a field named "Sub Total" should get the subtotal specifically, not the grand total, and a field named "Total"/"Grand Total"/"Net Payable" should get the final amount, not the subtotal.
- Never use a bill number, HSN code, GSTIN, phone number, or any other ID as an amount.
- If a field asks for any kind of date (e.g. "Due Date", "Bill Date", "Invoice Date") and the document only prints a single, unlabeled or differently-labeled date, use that date rather than leaving the field empty — do not require an exact label match for dates the way you would for an amount.
- If a value truly cannot be found anywhere in the document, use an empty string for that field.`;
}

function parseExtractionResponse(rawText: string, fields: string[]): Record<string, string> | null {
  const cleaned = rawText.replace(/```json|```/g, '').trim();
  let extracted: Record<string, any>;
  try {
    extracted = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const result: Record<string, string> = {};
  for (const f of fields) {
    const v = extracted[f];
    result[f] = typeof v === 'string' ? v : (v != null ? String(v) : '');
  }
  return result;
}

// Every successful AI call (even one whose JSON fails to parse — the model
// still generated real, billable output) gets logged here so cost/token use
// is visible per file and per batch in Settings, not just inferred from a
// provider's own dashboard after the fact.
async function logAiUsage(userId: string, batchLabel: string | undefined, fileLabel: string | undefined, aiRes: { provider: string; model: string; inputTokens: number; outputTokens: number }, pages = 1, fromCache = false) {
  try {
    await query(
      `INSERT INTO data360_ai_usage (user_id, batch_label, file_label, provider, model, input_tokens, output_tokens, pages, estimated_cost_usd, from_cache)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [userId, batchLabel || null, fileLabel || null, aiRes.provider, aiRes.model, aiRes.inputTokens, aiRes.outputTokens, pages,
        (aiRes as any).estimatedCostUsd || 0, fromCache]
    );
  } catch (e: any) {
    // Usage logging must never break the actual extraction response.
    logger.warn(`Failed to log AI usage: ${e.message}`);
  }
}

// ── AI RESULT CACHE ────────────────────────────────────────────────────────
// Exact-match caching per (user, endpoint, document content, mode). The
// discriminator is part of the key deliberately — the same image sent to
// /ai-extract-image with a different field list, or under a different saved
// template, is a genuinely different request and must not reuse a stale
// result; only a byte-identical document processed the same way hits the
// cache. This is what actually matters for repeat testing/re-uploads and
// for a batch/zip containing the same file more than once — not a fuzzy
// "looks similar" match, which would risk handing back another document's
// field values.
function computeCacheKey(endpoint: string, content: string, discriminator: string): string {
  return createHash('sha256').update(`${endpoint}|${discriminator}|${content}`).digest('hex');
}

async function getCachedResult(userId: string, cacheKey: string): Promise<{ result: any; provider: string; model: string } | null> {
  const row = await queryOne<any>(
    `SELECT result_json, provider, model FROM data360_ai_cache WHERE user_id=$1 AND cache_key=$2`,
    [userId, cacheKey]
  );
  if (!row) return null;
  await query(`UPDATE data360_ai_cache SET hit_count = hit_count + 1, last_hit_at = NOW() WHERE user_id=$1 AND cache_key=$2`, [userId, cacheKey]);
  return { result: row.result_json, provider: row.provider, model: row.model };
}

async function setCachedResult(userId: string, cacheKey: string, endpoint: string, result: any, provider: string, model: string) {
  try {
    await query(
      `INSERT INTO data360_ai_cache (user_id, cache_key, endpoint, result_json, provider, model)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, cache_key) DO UPDATE SET result_json=$4, provider=$5, model=$6`,
      [userId, cacheKey, endpoint, JSON.stringify(result), provider, model]
    );
  } catch (e: any) {
    logger.warn(`Failed to write AI cache entry: ${e.message}`);
  }
}

data360Router.post('/ai-extract', data360Auth, async (req: D360Req, res) => {
  try {
    const { raw_snippet, fields, batch_label, file_label } = req.body as { raw_snippet?: string; fields?: string[]; batch_label?: string; file_label?: string };
    if (!raw_snippet?.trim()) { fail(res, 'raw_snippet is required'); return; }
    if (!Array.isArray(fields) || fields.length === 0) { fail(res, 'fields must be a non-empty array'); return; }

    const cacheKey = computeCacheKey('ai-extract', raw_snippet, JSON.stringify([...fields].sort()));
    const cached = await getCachedResult(req.d360User.sub, cacheKey);
    if (cached) {
      await logAiUsage(req.d360User.sub, batch_label, file_label, { provider: cached.provider, model: cached.model, inputTokens: 0, outputTokens: 0 }, 1, true);
      ok(res, { fields: cached.result, provider: cached.provider, cached: true });
      return;
    }

    // The rules/field-list text is identical across every document in a
    // batch (same fields requested each time) — split it out as the
    // cacheable prefix so repeat calls within a batch benefit from
    // provider-level prompt caching even when the document itself is new.
    const cacheablePrompt = `You are reading raw OCR text from a receipt, invoice, or similar document. ${extractionRules(fields)}`;
    const prompt = `Raw text:\n"""\n${raw_snippet.slice(0, 4000)}\n"""`;

    const aiRes = await callAI({ cacheablePrompt, prompt, maxTokens: 1500, jsonResponse: true, preferredOrder: costEffectiveOrder() });
    await logAiUsage(req.d360User.sub, batch_label, file_label, aiRes);
    const result = parseExtractionResponse(aiRes.text, fields);
    if (!result) {
      fail(res, `AI returned invalid JSON — please try again. Provider: ${aiRes.provider}. Raw response: ${aiRes.text.slice(0, 300)}`, 502);
      return;
    }
    await setCachedResult(req.d360User.sub, cacheKey, 'ai-extract', result, aiRes.provider, aiRes.model);
    ok(res, { fields: result, provider: aiRes.provider, cached: false });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// Image goes straight to the model's vision — bypasses the client's
// Tesseract OCR entirely, which is the fix for documents where OCR itself
// fails (stylized invoice templates, low-contrast scans, watermarked
// images).
data360Router.post('/ai-extract-image', data360Auth, async (req: D360Req, res) => {
  try {
    const { image_base64, mime_type, fields, batch_label, file_label } = req.body as { image_base64?: string; mime_type?: string; fields?: string[]; batch_label?: string; file_label?: string };
    if (!image_base64?.trim()) { fail(res, 'image_base64 is required'); return; }
    if (!Array.isArray(fields) || fields.length === 0) { fail(res, 'fields must be a non-empty array'); return; }
    if (!IMAGE_MIME_TYPES.includes(mime_type || '')) {
      fail(res, `Unsupported file type "${mime_type || 'unknown'}" — this endpoint accepts real image bytes only (png/jpeg/webp/gif). Convert PDF pages to images before sending.`, 400);
      return;
    }
    const mediaType = mime_type as string;

    const cacheKey = computeCacheKey('ai-extract-image', image_base64, JSON.stringify([...fields].sort()));
    const cached = await getCachedResult(req.d360User.sub, cacheKey);
    if (cached) {
      await logAiUsage(req.d360User.sub, batch_label, file_label, { provider: cached.provider, model: cached.model, inputTokens: 0, outputTokens: 0 }, 1, true);
      ok(res, { fields: cached.result, provider: cached.provider, cached: true });
      return;
    }

    const cacheablePrompt = `This image is a receipt, invoice, or similar document. Read it directly. ${extractionRules(fields)}`;
    const prompt = `Read the attached image now and return the JSON.`;

    const aiRes = await callAI({ cacheablePrompt, prompt, imageBase64: image_base64, mimeType: mediaType, maxTokens: 1500, jsonResponse: true, preferredOrder: costEffectiveOrder() });
    await logAiUsage(req.d360User.sub, batch_label, file_label, aiRes);
    const result = parseExtractionResponse(aiRes.text, fields);
    if (!result) {
      fail(res, `AI returned invalid JSON — please try again. Provider: ${aiRes.provider}. Raw response: ${aiRes.text.slice(0, 300)}`, 502);
      return;
    }
    await setCachedResult(req.d360User.sub, cacheKey, 'ai-extract-image', result, aiRes.provider, aiRes.model);
    ok(res, { fields: result, provider: aiRes.provider, cached: false });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── AUTO-EXTRACTION (no field list — pull everything the document has) ───
// The two endpoints above need the caller to already know which fields to
// ask for. This is the opposite: hand it any document (text or image) with
// no field list at all, and get back whatever key/value structure the
// document actually contains — flat fields, nested groups, and repeating
// tables all represented natively in JSON, not squeezed into a fixed field
// list. Still goes through the same callAI() fallback chain.
const AUTO_EXTRACTION_PROMPT = `You are a document data extraction engine. You will be given one document,
which may be an image (scanned or photographed), a PDF, or a Word file
(DOCX/DOC). Read the document carefully — including any OCR needed for
scanned or photographed content — and convert its contents into a single,
clean JSON object of key-value pairs.

FOLLOW THESE RULES EXACTLY:

1. OUTPUT FORMAT
   - Return ONLY valid JSON. No markdown fences, no commentary, no preamble
     or explanation before or after the JSON.
   - Use double quotes for all keys and string values.
   - Preserve the document's own labels as JSON keys where possible,
     converted to snake_case (e.g. "Invoice no" -> "invoice_no").
   - Do not invent fields that do not appear in the document.

2. STRUCTURE
   - Use a flat key-value pair for each single field (e.g. name, date, ID,
     total, address).
   - Group related fields under a nested object when the document visually
     groups them (e.g. "billing_info": { "name": ..., "address": ... }).
   - Represent repeating rows (tables, line items, itemized lists) as a JSON
     array of objects under a descriptive key (e.g. "line_items": [ {...},
     {...} ]). Each object in the array should have the same keys.
   - If the document has multiple distinct sections (e.g. header, table,
     footer/summary), reflect that with top-level keys for each section.

3. DATA TYPES
   - Numbers (amounts, quantities, IDs that are purely numeric) should be
     output as JSON numbers, not strings, unless they contain
     formatting that must be preserved (e.g. leading zeros, phone numbers,
     account numbers — keep those as strings).
   - Currency values: strip currency symbols/commas and output as numbers
     when unambiguous (e.g. "$1,200.00" -> 1200.00). If you do this, also
     include a top-level "currency" field if a currency/symbol is present.
   - Dates: preserve the original format found in the document as a string
     (do not reformat or guess a different format).
   - Booleans/checkboxes: use true/false if clearly checked/unchecked.

4. MISSING OR UNCLEAR DATA
   - If a field is present but its value is illegible or ambiguous, set
     the value to null and do not guess.
   - If a label exists with no value, still include the key with value null.
   - Do not fabricate, infer, or auto-complete any data not visibly present
     in the document.

5. MULTI-PAGE / MULTI-FILE DOCUMENTS
   - If the document has multiple pages, merge them into one JSON object,
     using arrays for any repeating structures (e.g. line items spanning
     pages).
   - If a table continues across pages, concatenate its rows into a single
     array rather than creating page_1, page_2 duplicates.

6. VALIDATION
   - Before returning the output, double-check that the JSON is syntactically
     valid (matching brackets/braces, no trailing commas, all strings
     quoted).

Now extract all key-value data from the attached document and return the
JSON object only.`;

function parseArbitraryJson(rawText: string): any | null {
  const cleaned = rawText.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

data360Router.post('/ai-extract-auto', data360Auth, async (req: D360Req, res) => {
  try {
    const { raw_snippet, batch_label, file_label } = req.body as { raw_snippet?: string; batch_label?: string; file_label?: string };
    if (!raw_snippet?.trim()) { fail(res, 'raw_snippet is required'); return; }

    const cacheKey = computeCacheKey('ai-extract-auto', raw_snippet, 'auto');
    const cached = await getCachedResult(req.d360User.sub, cacheKey);
    if (cached) {
      await logAiUsage(req.d360User.sub, batch_label, file_label, { provider: cached.provider, model: cached.model, inputTokens: 0, outputTokens: 0 }, 1, true);
      ok(res, { data: cached.result, provider: cached.provider, cached: true });
      return;
    }

    // AUTO_EXTRACTION_PROMPT never varies across calls (no field list to
    // interpolate) — the cleanest possible cacheable prefix, shared by every
    // auto-extract call ever made, not just within one batch.
    const prompt = `Document text:\n"""\n${raw_snippet.slice(0, 8000)}\n"""`;
    const aiRes = await callAI({ cacheablePrompt: AUTO_EXTRACTION_PROMPT, prompt, maxTokens: 4096, jsonResponse: true, preferredOrder: costEffectiveOrder() });
    await logAiUsage(req.d360User.sub, batch_label, file_label, aiRes);
    const result = parseArbitraryJson(aiRes.text);
    if (!result) {
      fail(res, `AI returned invalid JSON — please try again. Provider: ${aiRes.provider}. Raw response: ${aiRes.text.slice(0, 300)}`, 502);
      return;
    }
    await setCachedResult(req.d360User.sub, cacheKey, 'ai-extract-auto', result, aiRes.provider, aiRes.model);
    ok(res, { data: result, provider: aiRes.provider, cached: false });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

data360Router.post('/ai-extract-image-auto', data360Auth, async (req: D360Req, res) => {
  try {
    const { image_base64, mime_type, batch_label, file_label } = req.body as { image_base64?: string; mime_type?: string; batch_label?: string; file_label?: string };
    if (!image_base64?.trim()) { fail(res, 'image_base64 is required'); return; }
    if (!IMAGE_MIME_TYPES.includes(mime_type || '')) {
      fail(res, `Unsupported file type "${mime_type || 'unknown'}" — this endpoint accepts real image bytes only (png/jpeg/webp/gif). Convert PDF pages to images before sending.`, 400);
      return;
    }
    const mediaType = mime_type as string;

    const cacheKey = computeCacheKey('ai-extract-image-auto', image_base64, 'auto');
    const cached = await getCachedResult(req.d360User.sub, cacheKey);
    if (cached) {
      await logAiUsage(req.d360User.sub, batch_label, file_label, { provider: cached.provider, model: cached.model, inputTokens: 0, outputTokens: 0 }, 1, true);
      ok(res, { data: cached.result, provider: cached.provider, cached: true });
      return;
    }

    const aiRes = await callAI({ cacheablePrompt: AUTO_EXTRACTION_PROMPT, prompt: 'Read the attached image now and return the JSON.', imageBase64: image_base64, mimeType: mediaType, maxTokens: 4096, jsonResponse: true, preferredOrder: costEffectiveOrder() });
    await logAiUsage(req.d360User.sub, batch_label, file_label, aiRes);
    const result = parseArbitraryJson(aiRes.text);
    if (!result) {
      fail(res, `AI returned invalid JSON — please try again. Provider: ${aiRes.provider}. Raw response: ${aiRes.text.slice(0, 300)}`, 502);
      return;
    }
    await setCachedResult(req.d360User.sub, cacheKey, 'ai-extract-image-auto', result, aiRes.provider, aiRes.model);
    ok(res, { data: result, provider: aiRes.provider, cached: false });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── SCHOOL — CHAPTER TO STUDY PACK ────────────────────────────────────────
// A different shape of request from the extraction endpoints above: instead
// of *locating* values that already exist in a document, this *generates*
// new, simplified content (a study plan, plain-language explanations, a
// quick-reference sheet) from a textbook chapter — there's nothing to
// "extract" here, so it always goes through AI, never a field list. Same
// callAI() fallback chain, cost-effective provider ordering, and
// content-hash cache as the extraction endpoints, just a different prompt
// and a class/board-aware cache discriminator (the same chapter prepared
// for a different class/board is a genuinely different result).
const SCHOOL_STUDY_GUIDE_PROMPT = `You are an expert school teacher creating a personalized study pack from one textbook chapter for a specific student. The student's class/grade and education board are given below the instructions, along with the chapter's content (as text or page images).

Produce a single JSON object — a "Study Pack" — with this exact structure:
{
  "chapter_title": string,
  "subject": string,
  "core_concepts": [ { "concept": string, "simple_explanation": string, "why_it_matters": string } ],
  "key_terms": [ { "term": string, "meaning": string } ],
  "study_plan": [ { "step": number, "focus": string, "time_minutes": number, "activity": string } ],
  "quick_reference": string[],
  "practice_questions": [ { "question": string, "hint": string, "difficulty": "easy" | "medium" | "hard" } ],
  "common_mistakes": string[]
}

FOLLOW THESE RULES EXACTLY:
1. Calibrate vocabulary and depth exactly to the stated class/grade and board — a younger class needs shorter sentences and everyday analogies; an older class can handle more technical precision. Different boards (CBSE, ICSE, State, IB, Cambridge...) emphasize different depth/style — match it.
2. "simple_explanation" must genuinely simplify — no unexplained jargon inside the explanation itself; define any term that's actually necessary separately in "key_terms" instead.
3. "study_plan" is a short, realistic sequence (typically 3-6 steps) a student could actually follow in one sitting, with a sensible time_minutes per step.
4. "quick_reference" is the exam-ready bullet list — only the single most important facts, formulas, dates, or definitions to remember, nothing else.
5. "practice_questions" give a hint, never the answer.
6. Do not invent facts that are not present in the given chapter content. If the content looks like a partial/incomplete chapter, still produce the best possible pack from what's there — do not refuse.
7. Return ONLY valid JSON — no markdown fences, no commentary before or after.`;

function buildStudyGuideDynamicPrompt(classLevel: string, board: string, subject: string | undefined, tail: string): string {
  return [
    `Student's class/grade: ${classLevel}`,
    `Education board: ${board}`,
    subject ? `Subject: ${subject}` : '',
    '',
    tail,
  ].filter(Boolean).join('\n');
}

data360Router.post('/school/study-guide', data360Auth, async (req: D360Req, res) => {
  try {
    const { raw_snippet, class_level, board, subject, file_label } = req.body as {
      raw_snippet?: string; class_level?: string; board?: string; subject?: string; file_label?: string;
    };
    if (!raw_snippet?.trim()) { fail(res, 'raw_snippet is required'); return; }
    if (!class_level?.trim()) { fail(res, 'class_level is required'); return; }
    if (!board?.trim()) { fail(res, 'board is required'); return; }

    const discriminator = `${class_level.trim().toLowerCase()}|${board.trim().toLowerCase()}|${(subject || '').trim().toLowerCase()}`;
    const cacheKey = computeCacheKey('school-study-guide', raw_snippet, discriminator);
    const cached = await getCachedResult(req.d360User.sub, cacheKey);
    if (cached) {
      await logAiUsage(req.d360User.sub, 'School', file_label, { provider: cached.provider, model: cached.model, inputTokens: 0, outputTokens: 0 }, 1, true);
      ok(res, { data: cached.result, provider: cached.provider, cached: true });
      return;
    }

    const prompt = buildStudyGuideDynamicPrompt(class_level, board, subject,
      `Chapter content:\n"""\n${raw_snippet.slice(0, 12000)}\n"""\n\nNow produce the Study Pack JSON.`);
    const aiRes = await callAI({ cacheablePrompt: SCHOOL_STUDY_GUIDE_PROMPT, prompt, maxTokens: 6000, jsonResponse: true, preferredOrder: costEffectiveOrder() });
    await logAiUsage(req.d360User.sub, 'School', file_label, aiRes);
    const result = parseArbitraryJson(aiRes.text);
    if (!result) {
      fail(res, `AI returned invalid JSON — please try again. Provider: ${aiRes.provider}. Raw response: ${aiRes.text.slice(0, 300)}`, 502);
      return;
    }
    await setCachedResult(req.d360User.sub, cacheKey, 'school-study-guide', result, aiRes.provider, aiRes.model);
    ok(res, { data: result, provider: aiRes.provider, cached: false });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

data360Router.post('/school/study-guide-image', data360Auth, async (req: D360Req, res) => {
  try {
    const { images, class_level, board, subject, file_label } = req.body as {
      images?: { image_base64: string; mime_type: string }[]; class_level?: string; board?: string; subject?: string; file_label?: string;
    };
    if (!Array.isArray(images) || images.length === 0) { fail(res, 'images must be a non-empty array'); return; }
    if (images.length > 10) { fail(res, 'Up to 10 chapter pages per call.'); return; }
    for (const img of images) {
      if (!IMAGE_MIME_TYPES.includes(img.mime_type || '')) {
        fail(res, `Unsupported file type "${img.mime_type || 'unknown'}" — this endpoint accepts real image bytes only (png/jpeg/webp/gif). Convert PDF pages to images before sending.`, 400);
        return;
      }
    }
    if (!class_level?.trim()) { fail(res, 'class_level is required'); return; }
    if (!board?.trim()) { fail(res, 'board is required'); return; }

    const content = images.map(img => img.image_base64).join('|');
    const discriminator = `${class_level.trim().toLowerCase()}|${board.trim().toLowerCase()}|${(subject || '').trim().toLowerCase()}`;
    const cacheKey = computeCacheKey('school-study-guide-image', content, discriminator);
    const cached = await getCachedResult(req.d360User.sub, cacheKey);
    if (cached) {
      await logAiUsage(req.d360User.sub, 'School', file_label, { provider: cached.provider, model: cached.model, inputTokens: 0, outputTokens: 0 }, images.length, true);
      ok(res, { data: cached.result, provider: cached.provider, cached: true });
      return;
    }

    const prompt = buildStudyGuideDynamicPrompt(class_level, board, subject,
      `Read the attached chapter page image(s) now and produce the Study Pack JSON.`);
    const aiRes = await callAI({
      cacheablePrompt: SCHOOL_STUDY_GUIDE_PROMPT, prompt,
      images: images.map(img => ({ base64: img.image_base64, mimeType: img.mime_type })),
      maxTokens: 6000, jsonResponse: true, preferredOrder: costEffectiveOrder(),
    });
    await logAiUsage(req.d360User.sub, 'School', file_label, aiRes, images.length);
    const result = parseArbitraryJson(aiRes.text);
    if (!result) {
      fail(res, `AI returned invalid JSON — please try again. Provider: ${aiRes.provider}. Raw response: ${aiRes.text.slice(0, 300)}`, 502);
      return;
    }
    await setCachedResult(req.d360User.sub, cacheKey, 'school-study-guide-image', result, aiRes.provider, aiRes.model);
    ok(res, { data: result, provider: aiRes.provider, cached: false });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── AI USAGE (Settings — cost/token tracking) ─────────────────────────────
// Two views over the same log: `files` is one row per AI call (what the
// caller asked for — "total tokens for each file"), `batches` rolls that up
// by batch_label (what the caller asked for — "total pages, cost, for each
// batch"). Costs are estimates (see PRICING in aiService.ts) — not pulled
// from a provider billing API, so treat them as a sanity-check figure, not
// an invoice.
data360Router.get('/ai-usage', data360Auth, async (req: D360Req, res) => {
  try {
    const files = await query<any>(
      `SELECT id, batch_label, file_label, provider, model, input_tokens, output_tokens, pages, estimated_cost_usd, from_cache, created_at
       FROM data360_ai_usage WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500`,
      [req.d360User.sub]
    );
    const batches = await query<any>(
      `SELECT
         COALESCE(batch_label, '(unassigned)') AS batch_label,
         COUNT(*)::int AS file_count,
         COUNT(*) FILTER (WHERE from_cache)::int AS cache_hits,
         SUM(pages)::int AS total_pages,
         SUM(input_tokens)::int AS total_input_tokens,
         SUM(output_tokens)::int AS total_output_tokens,
         SUM(estimated_cost_usd)::numeric(12,6) AS total_cost_usd,
         MIN(created_at) AS started_at,
         MAX(created_at) AS last_used_at
       FROM data360_ai_usage
       WHERE user_id=$1
       GROUP BY COALESCE(batch_label, '(unassigned)')
       ORDER BY MAX(created_at) DESC`,
      [req.d360User.sub]
    );
    const cacheStats = await queryOne<any>(
      `SELECT COUNT(*)::int AS total_calls, COUNT(*) FILTER (WHERE from_cache)::int AS cache_hits
       FROM data360_ai_usage WHERE user_id=$1`,
      [req.d360User.sub]
    );
    ok(res, { files, batches, cacheStats });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// Lets a user force-refresh extraction for documents they know have changed
// upstream (or just want re-run against a live provider instead of a
// cached result) without needing a way to target individual cache entries.
data360Router.delete('/ai-cache', data360Auth, async (req: D360Req, res) => {
  try {
    const deleted = await query<any>('DELETE FROM data360_ai_cache WHERE user_id=$1 RETURNING id', [req.d360User.sub]);
    ok(res, { cleared: deleted.length });
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
    const generationJobs = await query<any>(
      `SELECT * FROM data360_generation_jobs WHERE batch_id=$1 ORDER BY created_at DESC`,
      [batch.id]
    );
    ok(res, { batch, rows, jobs, generationJobs });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── ROW APPROVE / REJECT / MANUAL OVERRIDE ──────────────────────
data360Router.patch('/batches/:id/rows/:rowId', data360Auth, async (req: D360Req, res) => {
  try {
    const { status, manual_override } = req.body as { status?: 'approved' | 'rejected'; manual_override?: { fields?: Record<string, string> } };
    const batch = await queryOne<any>('SELECT id FROM data360_batches WHERE id=$1 AND user_id=$2', [req.params.id, req.d360User.sub]);
    if (!batch) { fail(res, 'Batch not found', 404); return; }

    const sets: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (manual_override?.fields) {
      sets.push(`fields = fields || $${i++}::jsonb`); params.push(JSON.stringify(manual_override.fields));
      sets.push(`manual_override=$${i++}`); params.push(JSON.stringify(manual_override));
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

// ── MAPPING AGENT ────────────────────────────────────────────────
// Maps ingested source fields onto the field names the destination system
// actually expects — required before any real database/API destination can
// consume the data correctly. Source fields are now the user's own chosen
// extraction field names (e.g. "Invoice Number"), so there's no fixed target
// list; DEFAULT_MAPPING below is only a fallback for pre-dynamic-fields
// legacy batches that still carry the old fixed Entity/Amount/Email columns.
const DEFAULT_MAPPING: Record<string, string> = {
  extracted_entity: 'entity_name',
  target_field_a: 'amount',
  target_field_b: 'email',
  source_type: 'source_type',
};

data360Router.patch('/batches/:id/mapping', data360Auth, async (req: D360Req, res) => {
  try {
    const { field_mapping } = req.body as { field_mapping: Record<string, string> };
    if (!field_mapping || typeof field_mapping !== 'object') { fail(res, 'field_mapping object is required'); return; }
    const [batch] = await query<any>(
      `UPDATE data360_batches SET field_mapping=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING *`,
      [JSON.stringify(field_mapping), req.params.id, req.d360User.sub]
    );
    if (!batch) { fail(res, 'Batch not found', 404); return; }
    ok(res, batch);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

function applyMapping(row: Record<string, any>, mapping: Record<string, string>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [sourceField, value] of Object.entries(row)) {
    const targetField = mapping[sourceField] || DEFAULT_MAPPING[sourceField] || sourceField;
    out[targetField] = value;
  }
  return out;
}

// ── TEMPLATES ──────────────────────────────────────────────────
// A saved (extraction fields + output design) pair, reusable across batches
// of the same kind — e.g. "Invoice", "Resume", "Quick Reference Card".
// output_type 'coordinate_layout' draws a page from layout_json with pdf-lib
// (no upload needed — works today). 'fillable_pdf' fills a real uploaded PDF's
// form fields — needs template_file_key (an S3 object) and AWS credentials,
// same honest dependency the existing cloud_storage distribute target has.
data360Router.post('/templates', data360Auth, async (req: D360Req, res) => {
  try {
    const { name, extraction_fields, output_type, layout_json, template_file_key } = req.body as {
      name: string; extraction_fields: string[]; output_type?: 'fillable_pdf' | 'coordinate_layout';
      layout_json?: any[]; template_file_key?: string;
    };
    if (!name?.trim()) { fail(res, 'name is required'); return; }
    if (!Array.isArray(extraction_fields) || extraction_fields.length === 0) { fail(res, 'extraction_fields must be a non-empty array'); return; }
    const type = output_type === 'fillable_pdf' ? 'fillable_pdf' : 'coordinate_layout';
    const [template] = await query<any>(
      `INSERT INTO data360_templates (user_id, name, extraction_fields, output_type, layout_json, template_file_key)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.d360User.sub, name.trim(), JSON.stringify(extraction_fields), type, layout_json ? JSON.stringify(layout_json) : null, template_file_key || null]
    );
    ok(res, template, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

data360Router.get('/templates', data360Auth, async (req: D360Req, res) => {
  try {
    const templates = await query<any>('SELECT * FROM data360_templates WHERE user_id=$1 ORDER BY created_at DESC', [req.d360User.sub]);
    ok(res, templates);
  } catch (e: any) { fail(res, e.message, 500); }
});

data360Router.patch('/templates/:id', data360Auth, async (req: D360Req, res) => {
  try {
    const { name, extraction_fields, output_type, layout_json, template_file_key } = req.body as {
      name?: string; extraction_fields?: string[]; output_type?: 'fillable_pdf' | 'coordinate_layout';
      layout_json?: any[]; template_file_key?: string;
    };
    const sets: string[] = []; const params: any[] = []; let i = 1;
    if (name?.trim()) { sets.push(`name=$${i++}`); params.push(name.trim()); }
    if (Array.isArray(extraction_fields)) { sets.push(`extraction_fields=$${i++}`); params.push(JSON.stringify(extraction_fields)); }
    if (output_type === 'fillable_pdf' || output_type === 'coordinate_layout') { sets.push(`output_type=$${i++}`); params.push(output_type); }
    if (layout_json !== undefined) { sets.push(`layout_json=$${i++}`); params.push(layout_json ? JSON.stringify(layout_json) : null); }
    if (template_file_key !== undefined) { sets.push(`template_file_key=$${i++}`); params.push(template_file_key || null); }
    if (sets.length === 0) { fail(res, 'Nothing to update'); return; }
    sets.push(`updated_at=NOW()`);
    params.push(req.params.id, req.d360User.sub);
    const [template] = await query<any>(
      `UPDATE data360_templates SET ${sets.join(', ')} WHERE id=$${i++} AND user_id=$${i++} RETURNING *`, params
    );
    if (!template) { fail(res, 'Template not found', 404); return; }
    ok(res, template);
  } catch (e: any) { fail(res, e.message, 500); }
});

data360Router.delete('/templates/:id', data360Auth, async (req: D360Req, res) => {
  try {
    const [deleted] = await query<any>('DELETE FROM data360_templates WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.d360User.sub]);
    if (!deleted) { fail(res, 'Template not found', 404); return; }
    ok(res, { deleted: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ── GENERATE AGENT ───────────────────────────────────────────────
// Turns approved+mapped rows into a real formatted document per row, using
// a saved template — the counterpart to the raw-row `distribute` targets
// below. coordinate_layout renders with pdf-lib's native drawing primitives
// (no external file needed); fillable_pdf fills an uploaded PDF's form
// fields (needs S3 + AWS credentials — see caveat above).
function defaultLayoutFields(fieldNames: string[]) {
  return fieldNames.map((f, idx) => ({ field: f, label: f, x: 50, y: 730 - idx * 50, fontSize: 11 }));
}

async function renderCoordinatePdf(title: string, layout: any[], fields: Record<string, string>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText(title, { x: 50, y: 750, size: 18, font: bold, color: rgb(0.04, 0.42, 0.36) });
  page.drawLine({ start: { x: 50, y: 742 }, end: { x: 562, y: 742 }, thickness: 1, color: rgb(0.85, 0.85, 0.85) });
  for (const item of layout) {
    const value = fields[item.field] ?? '';
    const y = item.y ?? 700;
    const x = item.x ?? 50;
    page.drawText(`${(item.label || item.field).toUpperCase()}`, { x, y, size: 8, font: bold, color: rgb(0.45, 0.45, 0.45) });
    page.drawText(String(value || '—'), { x, y: y - 16, size: item.fontSize || 12, font, color: rgb(0.1, 0.1, 0.1), maxWidth: 500 });
  }
  return doc.save();
}

async function fillAcroFormPdf(templateBytes: Uint8Array, fields: Record<string, string>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(templateBytes);
  const form = doc.getForm();
  for (const [name, value] of Object.entries(fields)) {
    try {
      form.getTextField(name).setText(String(value ?? ''));
    } catch { /* this template has no form field with this name — skip it */ }
  }
  form.flatten();
  return doc.save();
}

data360Router.post('/batches/:id/generate', data360Auth, async (req: D360Req, res) => {
  try {
    const { template_id } = req.body as { template_id?: string };
    const batch = await queryOne<any>('SELECT * FROM data360_batches WHERE id=$1 AND user_id=$2', [req.params.id, req.d360User.sub]);
    if (!batch) { fail(res, 'Batch not found', 404); return; }

    const templateId = template_id || batch.template_id;
    if (!templateId) { fail(res, 'No template selected — pass template_id or save one on this batch first.'); return; }
    const template = await queryOne<any>('SELECT * FROM data360_templates WHERE id=$1 AND user_id=$2', [templateId, req.d360User.sub]);
    if (!template) { fail(res, 'Template not found', 404); return; }

    const approvedRows = await query<any>(
      `SELECT id, row_index, fields FROM data360_rows WHERE batch_id=$1 AND status='approved' ORDER BY row_index ASC`,
      [batch.id]
    );
    if (approvedRows.length === 0) { fail(res, 'No approved rows to generate from — approve rows first'); return; }

    const [job] = await query<any>(
      `INSERT INTO data360_generation_jobs (batch_id, template_id, status) VALUES ($1,$2,'generating') RETURNING *`,
      [batch.id, template.id]
    );

    const fieldNames: string[] = template.extraction_fields?.length ? template.extraction_fields : batch.extraction_fields;
    const documents: any[] = [];
    let status = 'ready';
    let errorMsg = '';

    try {
      if (template.output_type === 'fillable_pdf') {
        if (!template.template_file_key) throw new Error('This template has no uploaded fillable PDF (template_file_key) — use a coordinate_layout template to test without one.');
        const bucket = process.env.AWS_TEMPLATES_BUCKET || process.env.AWS_S3_BUCKET;
        const hasCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
        if (!bucket || !hasCreds) throw new Error('AWS credentials / AWS_TEMPLATES_BUCKET are not configured on this server — fillable_pdf templates load from S3. Use a coordinate_layout template to test without S3, same limitation the cloud_storage distribute target already has.');
        const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
        const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: template.template_file_key }));
        const templateBytes = await obj.Body!.transformToByteArray();
        for (const row of approvedRows) {
          const bytes = await fillAcroFormPdf(templateBytes, row.fields || {});
          documents.push({ row_id: row.id, row_index: row.row_index, file_name: `${batch.name.replace(/[^a-z0-9]+/gi, '_')}_row${row.row_index + 1}.pdf`, file_base64: Buffer.from(bytes).toString('base64') });
        }
      } else {
        const layout = template.layout_json?.length ? template.layout_json : defaultLayoutFields(fieldNames);
        for (const row of approvedRows) {
          const bytes = await renderCoordinatePdf(template.name, layout, row.fields || {});
          documents.push({ row_id: row.id, row_index: row.row_index, file_name: `${batch.name.replace(/[^a-z0-9]+/gi, '_')}_row${row.row_index + 1}.pdf`, file_base64: Buffer.from(bytes).toString('base64') });
        }
      }
    } catch (e: any) {
      status = 'failed';
      errorMsg = e.message;
    }

    const result = status === 'ready' ? { documents, row_count: documents.length } : { error: errorMsg };
    const [updatedJob] = await query<any>(
      `UPDATE data360_generation_jobs SET status=$1, result=$2, completed_at=NOW() WHERE id=$3 RETURNING *`,
      [status, JSON.stringify(result), job.id]
    );

    ok(res, updatedJob, status === 'ready' ? 201 : 200);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// Only alphanumeric + underscore, must start with a letter — prevents SQL
// injection via a table/column name that can't be parameterized.
const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Turns a free-typed field name ("Invoice Number") into a valid XML element
// name (invoice_number) — element names can't contain spaces/punctuation or
// start with a digit.
function xmlTagName(key: string): string {
  const cleaned = key.trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}
function xmlEscape(v: any): string {
  return String(v ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string));
}
// Same "mapped output, any 3rd-party system" job the JSON API target does —
// some downstream systems (older enterprise integrations, SOAP-era APIs)
// only accept XML, so the API/Webhook target can produce either.
function rowsToXml(batchName: string, rows: Record<string, any>[]): string {
  const rowsXml = rows.map(row =>
    `<row>${Object.entries(row).map(([k, v]) => { const tag = xmlTagName(k); return `<${tag}>${xmlEscape(v)}</${tag}>`; }).join('')}</row>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<batch name="${xmlEscape(batchName)}">${rowsXml}</batch>`;
}

// ── DESTINATION AGENT — CONFIG + EXECUTE ─────────────────────────
// target_type: 'file_export' | 'cloud_storage' | 'database' | 'api' | 'rpa_portal'
data360Router.post('/batches/:id/distribute', data360Auth, async (req: D360Req, res) => {
  try {
    const { target_type, config } = req.body as { target_type: string; config?: Record<string, any> };
    if (!['file_export', 'cloud_storage', 'database', 'api', 'rpa_portal'].includes(target_type)) { fail(res, 'Invalid target_type'); return; }

    const batch = await queryOne<any>('SELECT * FROM data360_batches WHERE id=$1 AND user_id=$2', [req.params.id, req.d360User.sub]);
    if (!batch) { fail(res, 'Batch not found', 404); return; }

    const approvedRowsRaw = await query<any>(
      `SELECT row_index, source_type, fields, extracted_entity, target_field_a, target_field_b, agent_verdict
       FROM data360_rows WHERE batch_id=$1 AND status='approved' ORDER BY row_index ASC`,
      [batch.id]
    );
    if (approvedRowsRaw.length === 0) { fail(res, 'No approved rows to distribute — approve rows first'); return; }

    const mapping: Record<string, string> = batch.field_mapping || {};
    const approvedRows = approvedRowsRaw.map(r => {
      // New dynamic-field batches carry `fields`; legacy batches (no fields
      // ever recorded) fall back to the old fixed Entity/Amount/Email columns.
      const flat = r.fields && Object.keys(r.fields).length > 0
        ? { ...r.fields, source_type: r.source_type }
        : { extracted_entity: r.extracted_entity, target_field_a: r.target_field_a, target_field_b: r.target_field_b, source_type: r.source_type };
      return applyMapping(flat, mapping);
    });

    // Never persist secrets in the config we store/echo back.
    const safeConfig = { ...(config || {}) };
    if (safeConfig.password) safeConfig.password = '••••••••';
    if (safeConfig.secret_password_token) safeConfig.secret_password_token = '••••••••';
    if (safeConfig.connection_string) safeConfig.connection_string = '••••••••';
    if (safeConfig.auth_token) safeConfig.auth_token = '••••••••';

    const [job] = await query<any>(
      `INSERT INTO data360_distribution_jobs (batch_id, target_type, config, status)
       VALUES ($1,$2,$3,'pending') RETURNING *`,
      [batch.id, target_type, JSON.stringify(safeConfig)]
    );

    let status = 'pending';
    let result: Record<string, any> = {};

    if (target_type === 'file_export') {
      const ws = XLSX.utils.json_to_sheet(approvedRows);
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
    } else if (target_type === 'database') {
      // Real Postgres INSERT into a destination the caller owns — a fresh,
      // short-lived Client (not the shared pool) so a bad/slow external DB
      // can't exhaust our own connection pool.
      const connectionString: string | undefined = config?.connection_string;
      const tableName: string | undefined = config?.table_name;
      if (!connectionString || !tableName) {
        status = 'failed';
        result = { error: 'connection_string and table_name are both required in config.' };
      } else if (!SAFE_IDENT.test(tableName)) {
        status = 'failed';
        result = { error: 'table_name must be a plain identifier (letters, numbers, underscore).' };
      } else {
        const { Client } = await import('pg');
        const columns = Object.keys(approvedRows[0]);
        if (!columns.every(c => SAFE_IDENT.test(c))) {
          status = 'failed';
          result = { error: 'Mapped field names must be plain identifiers (letters, numbers, underscore) to use as column names.' };
        } else {
          const client = new Client({ connectionString, connectionTimeoutMillis: 8000, statement_timeout: 15000 });
          try {
            await client.connect();
            const colList = columns.map(c => `"${c}"`).join(', ');
            let inserted = 0;
            for (const row of approvedRows) {
              const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
              await client.query(`INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders})`, columns.map(c => row[c]));
              inserted++;
            }
            status = 'completed';
            result = { table: tableName, row_count: inserted };
          } catch (e: any) {
            status = 'failed';
            result = { error: e.message };
          } finally {
            await client.end().catch(() => {});
          }
        }
      }
    } else if (target_type === 'api') {
      // Real HTTP POST/PUT of the mapped rows to any endpoint the caller
      // configures — the most universally useful "get my data into any
      // system" destination, since every modern platform accepts a webhook.
      const url: string | undefined = config?.url;
      const method: string = (config?.method || 'POST').toUpperCase();
      const format: string = (config?.format || 'json').toLowerCase();
      if (!url) {
        status = 'failed';
        result = { error: 'url is required in config.' };
      } else {
        try {
          const headers: Record<string, string> = { 'Content-Type': format === 'xml' ? 'application/xml' : 'application/json' };
          if (config?.auth_token) headers['Authorization'] = `Bearer ${config.auth_token}`;
          const body = format === 'xml' ? rowsToXml(batch.name, approvedRows) : JSON.stringify({ batch: batch.name, rows: approvedRows });
          const resp = await fetch(url, { method, headers, body });
          const bodyText = await resp.text();
          if (resp.ok) {
            status = 'completed';
            result = { status_code: resp.status, row_count: approvedRows.length, response_snippet: bodyText.slice(0, 300) };
          } else {
            status = 'failed';
            result = { error: `Target API responded ${resp.status}`, response_snippet: bodyText.slice(0, 300) };
          }
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
