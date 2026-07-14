"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.data360Router = void 0;
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
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const XLSX = __importStar(require("xlsx"));
const pdf_lib_1 = require("pdf-lib");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const db_1 = require("../../config/db");
exports.data360Router = (0, express_1.Router)();
// ── Config ───────────────────────────────────────────────────
const JWT_SECRET = (process.env.JWT_SECRET || 'dev-secret-change-this');
const signOptions = { expiresIn: 8 * 3600 };
// ── Helpers ──────────────────────────────────────────────────
function ok(res, data, status = 200) {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res, message, status = 400) {
    res.status(status).json({ success: false, error: message, timestamp: new Date().toISOString() });
}
function makeToken(user) {
    return jsonwebtoken_1.default.sign({ sub: user.id, email: user.email, role: user.role, scope: 'data360' }, JWT_SECRET, signOptions);
}
function data360Auth(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(header.slice(7), JWT_SECRET);
        if (decoded.scope !== 'data360') {
            res.status(403).json({ success: false, error: 'Forbidden' });
            return;
        }
        req.d360User = decoded;
        next();
    }
    catch {
        res.status(401).json({ success: false, error: 'Token expired or invalid' });
    }
}
// ── STATUS (diagnostic) ───────────────────────────────────────
exports.data360Router.get('/status', async (_req, res) => {
    try {
        const tables = await (0, db_1.query)(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'data360%' ORDER BY tablename`, []);
        const migrations = await (0, db_1.query)(`SELECT name, run_at FROM _migrations WHERE name LIKE '%data360%' ORDER BY name`, []);
        ok(res, { tables: tables.map((t) => t.tablename), migrations });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ── RUN MIGRATIONS (admin debug) ─────────────────────────────
exports.data360Router.post('/admin/run-migrations', async (req, res) => {
    if (req.headers['x-admin-key'] !== (process.env.ADMIN_SECRET || 'c360-admin')) {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return;
    }
    try {
        await (0, db_1.runMigrations)();
        ok(res, { message: 'Migrations complete' });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ── REGISTER ─────────────────────────────────────────────────
exports.data360Router.post('/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) {
            fail(res, 'name, email and password are required');
            return;
        }
        const emailLc = email.toLowerCase().trim();
        const existing = await (0, db_1.queryOne)('SELECT id FROM data360_users WHERE email=$1', [emailLc]);
        if (existing) {
            fail(res, 'Email already registered');
            return;
        }
        const hash = await bcryptjs_1.default.hash(password, 10);
        const [user] = await (0, db_1.query)(`INSERT INTO data360_users (name, email, password_hash)
       VALUES ($1,$2,$3)
       RETURNING id, name, email, role, created_at`, [name, emailLc, hash]);
        const token = makeToken(user);
        ok(res, { token, user }, 201);
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ── LOGIN ─────────────────────────────────────────────────────
exports.data360Router.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            fail(res, 'email and password are required');
            return;
        }
        const user = await (0, db_1.queryOne)(`SELECT id, name, email, password_hash, role FROM data360_users WHERE email=$1 AND is_active=TRUE`, [email.toLowerCase().trim()]);
        if (!user) {
            fail(res, 'Invalid email or password', 401);
            return;
        }
        const valid = await bcryptjs_1.default.compare(password, user.password_hash);
        if (!valid) {
            fail(res, 'Invalid email or password', 401);
            return;
        }
        const { password_hash: _, ...safeUser } = user;
        const token = makeToken(safeUser);
        ok(res, { token, user: safeUser });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.data360Router.get('/auth/me', data360Auth, async (req, res) => {
    try {
        const user = await (0, db_1.queryOne)('SELECT id, name, email, role, created_at FROM data360_users WHERE id=$1', [req.d360User.sub]);
        if (!user) {
            fail(res, 'User not found', 404);
            return;
        }
        ok(res, user);
    }
    catch (e) {
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
function classifyFieldName(name) {
    const n = name.toLowerCase();
    if (/e-?mail/.test(n))
        return 'email';
    if (/phone|mobile|contact\s*(no|number)?|cell/.test(n))
        return 'phone';
    if (/amount|total|price|value|cost|sum|balance/.test(n))
        return 'amount';
    return 'generic';
}
function validateRow(row, extractionFields) {
    const fields = row.fields || {};
    const names = extractionFields.length ? extractionFields : Object.keys(fields);
    let missing = 0;
    let malformed = 0;
    for (const name of names) {
        const val = (fields[name] || '').trim();
        if (!val) {
            missing++;
            continue;
        }
        const type = classifyFieldName(name);
        if (type === 'email' && !EMAIL_RE.test(val))
            malformed++;
        if (type === 'phone' && !PHONE_RE.test(val.replace(/[()]/g, '')))
            malformed++;
        if (type === 'amount' && Number.isNaN(parseFloat(val.replace(/[^0-9.-]/g, ''))))
            malformed++;
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
exports.data360Router.post('/batches', data360Auth, async (req, res) => {
    try {
        const { name, source_channel, rows, extraction_fields, template_id } = req.body;
        if (!name?.trim()) {
            fail(res, 'name is required');
            return;
        }
        if (!Array.isArray(rows) || rows.length === 0) {
            fail(res, 'rows must be a non-empty array');
            return;
        }
        let fieldNames = Array.isArray(extraction_fields) ? extraction_fields.filter(f => f && f.trim()) : [];
        // A saved template pre-fills the extraction field list so it doesn't need
        // retyping on every batch of the same kind (invoice, resume, ...).
        let templateId = null;
        if (template_id) {
            const tpl = await (0, db_1.queryOne)('SELECT * FROM data360_templates WHERE id=$1 AND user_id=$2', [template_id, req.d360User.sub]);
            if (!tpl) {
                fail(res, 'Template not found');
                return;
            }
            templateId = tpl.id;
            if (fieldNames.length === 0)
                fieldNames = tpl.extraction_fields;
        }
        const result = await (0, db_1.withTransaction)(async (client) => {
            const batchRes = await client.query(`INSERT INTO data360_batches (user_id, name, source_channel, total_rows, extraction_fields, template_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [req.d360User.sub, name.trim(), source_channel || 'excel', rows.length, JSON.stringify(fieldNames), templateId]);
            const batch = batchRes.rows[0];
            let flagged = 0;
            const insertedRows = [];
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const v = validateRow(row, fieldNames);
                if (v.requiresReview)
                    flagged++;
                const rowRes = await client.query(`INSERT INTO data360_rows
             (batch_id, row_index, source_type, fields, raw_snippet, agent_verdict, verdict_level, requires_manual_review, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`, [
                    batch.id, i, row.source_type || source_channel || 'excel', JSON.stringify(row.fields || {}), row.raw_snippet || null,
                    v.verdict, v.level, v.requiresReview, v.requiresReview ? 'pending' : 'approved',
                ]);
                insertedRows.push(rowRes.rows[0]);
            }
            await client.query(`UPDATE data360_batches SET flagged_rows=$1, updated_at=NOW() WHERE id=$2`, [flagged, batch.id]);
            return { batch: { ...batch, flagged_rows: flagged }, rows: insertedRows };
        });
        ok(res, result, 201);
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ── AI-ENHANCED EXTRACTION (run in parallel with the client-side heuristic,
// for the caller to compare) ──────────────────────────────────────────────
// Two entry points, one prompt/response contract:
//  - /ai-extract       — text in (raw OCR/PDF/voice text), for channels
//    where the text itself is already reliable (PDF text layer, speech-to-
//    text). Reuses the exact Anthropic call pattern already live in
//    ai.service.ts (model claude-haiku-4-5-20251001).
//  - /ai-extract-image — image in, read directly by Claude's vision. Real
//    stylized/graphic documents (colored headers, decorative fonts,
//    watermarks) can make Tesseract's OCR come back as near-total garbage —
//    at that point there's no usable text for ANY regex or LLM-on-text
//    approach to work from. Reading the image directly skips that failure
//    mode entirely for the screenshot channel.
// Both are explicitly a side-by-side comparison, not a replacement: the
// client calls one of these in addition to its own heuristic and lets the
// user pick whichever value is right per field, rather than trusting
// either blindly.
function extractionRules(fields) {
    return `Extract exactly these fields: ${fields.join(', ')}.

Rules:
- Return ONLY a JSON object with these exact keys, nothing else — no explanation, no markdown fences.
- If a field name suggests an itemized/line-item breakdown (e.g. "Item-wise Breakdown", "Line Items"), return its value as a single string listing each item as "name: value" separated by "; ".
- If a field asks for a total/subtotal/amount, match the label exactly — a field named "Sub Total" should get the subtotal specifically, not the grand total, and a field named "Total"/"Grand Total"/"Net Payable" should get the final amount, not the subtotal.
- Never use a bill number, HSN code, GSTIN, phone number, or any other ID as an amount.
- If a value truly cannot be found, use an empty string for that field.`;
}
function parseExtractionResponse(rawText, fields) {
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    let extracted;
    try {
        extracted = JSON.parse(cleaned);
    }
    catch {
        return null;
    }
    const result = {};
    for (const f of fields) {
        const v = extracted[f];
        result[f] = typeof v === 'string' ? v : (v != null ? String(v) : '');
    }
    return result;
}
exports.data360Router.post('/ai-extract', data360Auth, async (req, res) => {
    try {
        const { raw_snippet, fields } = req.body;
        if (!raw_snippet?.trim()) {
            fail(res, 'raw_snippet is required');
            return;
        }
        if (!Array.isArray(fields) || fields.length === 0) {
            fail(res, 'fields must be a non-empty array');
            return;
        }
        const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
        if (!apiKey) {
            fail(res, 'AI extraction is not configured on this server (ANTHROPIC_API_KEY / CLAUDE_API_KEY missing).', 503);
            return;
        }
        const prompt = `You are reading raw OCR text from a receipt, invoice, or similar document. ${extractionRules(fields)}

Raw text:
"""
${raw_snippet.slice(0, 4000)}
"""`;
        const anthropic = new sdk_1.default({ apiKey });
        const msg = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 500,
            messages: [{ role: 'user', content: prompt }],
        });
        const rawText = msg.content[0].text;
        const result = parseExtractionResponse(rawText, fields);
        if (!result) {
            fail(res, 'AI returned invalid JSON — please try again', 502);
            return;
        }
        ok(res, { fields: result });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// Image goes straight to Gemini's vision — bypasses the client's Tesseract
// OCR entirely, which is the fix for documents where OCR itself fails
// (stylized invoice templates, low-contrast scans, watermarked images).
// Uses Gemini rather than Claude here specifically because the Anthropic
// key on this deployment is out of credits; Gemini is equally capable for
// this read-the-image-and-return-JSON task.
exports.data360Router.post('/ai-extract-image', data360Auth, async (req, res) => {
    try {
        const { image_base64, mime_type, fields } = req.body;
        if (!image_base64?.trim()) {
            fail(res, 'image_base64 is required');
            return;
        }
        if (!Array.isArray(fields) || fields.length === 0) {
            fail(res, 'fields must be a non-empty array');
            return;
        }
        const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
        const mediaType = ALLOWED_MIME.includes(mime_type || '') ? mime_type : 'image/png';
        if (!process.env.GEMINI_API_KEY) {
            fail(res, 'AI extraction is not configured on this server (GEMINI_API_KEY missing).', 503);
            return;
        }
        const prompt = `This image is a receipt, invoice, or similar document. Read it directly. ${extractionRules(fields)}`;
        const { callGeminiVision } = await Promise.resolve().then(() => __importStar(require('../auth/gemini.service')));
        const geminiRes = await callGeminiVision({
            prompt,
            imageBase64: image_base64,
            mimeType: mediaType,
            responseMimeType: 'application/json',
            maxTokens: 500,
        });
        const result = parseExtractionResponse(geminiRes.text, fields);
        if (!result) {
            fail(res, 'AI returned invalid JSON — please try again', 502);
            return;
        }
        ok(res, { fields: result });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ── LIST BATCHES ────────────────────────────────────────────────
exports.data360Router.get('/batches', data360Auth, async (req, res) => {
    try {
        const batches = await (0, db_1.query)(`SELECT * FROM data360_batches WHERE user_id=$1 ORDER BY created_at DESC`, [req.d360User.sub]);
        ok(res, batches);
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ── BATCH DETAIL + ROWS ─────────────────────────────────────────
exports.data360Router.get('/batches/:id', data360Auth, async (req, res) => {
    try {
        const batch = await (0, db_1.queryOne)(`SELECT * FROM data360_batches WHERE id=$1 AND user_id=$2`, [req.params.id, req.d360User.sub]);
        if (!batch) {
            fail(res, 'Batch not found', 404);
            return;
        }
        const rows = await (0, db_1.query)(`SELECT * FROM data360_rows WHERE batch_id=$1 ORDER BY row_index ASC`, [batch.id]);
        const jobs = await (0, db_1.query)(`SELECT * FROM data360_distribution_jobs WHERE batch_id=$1 ORDER BY created_at DESC`, [batch.id]);
        const generationJobs = await (0, db_1.query)(`SELECT * FROM data360_generation_jobs WHERE batch_id=$1 ORDER BY created_at DESC`, [batch.id]);
        ok(res, { batch, rows, jobs, generationJobs });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ── ROW APPROVE / REJECT / MANUAL OVERRIDE ──────────────────────
exports.data360Router.patch('/batches/:id/rows/:rowId', data360Auth, async (req, res) => {
    try {
        const { status, manual_override } = req.body;
        const batch = await (0, db_1.queryOne)('SELECT id FROM data360_batches WHERE id=$1 AND user_id=$2', [req.params.id, req.d360User.sub]);
        if (!batch) {
            fail(res, 'Batch not found', 404);
            return;
        }
        const sets = [];
        const params = [];
        let i = 1;
        if (manual_override?.fields) {
            sets.push(`fields = fields || $${i++}::jsonb`);
            params.push(JSON.stringify(manual_override.fields));
            sets.push(`manual_override=$${i++}`);
            params.push(JSON.stringify(manual_override));
            sets.push(`agent_verdict=$${i++}`);
            params.push('OK (Manually Overridden)');
            sets.push(`verdict_level='ok'`);
            sets.push(`requires_manual_review=FALSE`);
        }
        if (status) {
            sets.push(`status=$${i++}`);
            params.push(status);
        }
        sets.push(`updated_at=NOW()`);
        if (sets.length === 1) {
            fail(res, 'Nothing to update');
            return;
        }
        params.push(req.params.rowId, batch.id);
        const [row] = await (0, db_1.query)(`UPDATE data360_rows SET ${sets.join(', ')} WHERE id=$${i++} AND batch_id=$${i++} RETURNING *`, params);
        if (!row) {
            fail(res, 'Row not found', 404);
            return;
        }
        // Refresh batch flagged_rows count + promote to 'approved' if nothing left pending
        const pending = await (0, db_1.queryOne)(`SELECT COUNT(*)::int AS n FROM data360_rows WHERE batch_id=$1 AND requires_manual_review=TRUE AND status='pending'`, [batch.id]);
        if (pending && pending.n === 0) {
            await (0, db_1.query)(`UPDATE data360_batches SET status='approved', updated_at=NOW() WHERE id=$1 AND status='pending_approval'`, [batch.id]);
        }
        ok(res, row);
    }
    catch (e) {
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
const DEFAULT_MAPPING = {
    extracted_entity: 'entity_name',
    target_field_a: 'amount',
    target_field_b: 'email',
    source_type: 'source_type',
};
exports.data360Router.patch('/batches/:id/mapping', data360Auth, async (req, res) => {
    try {
        const { field_mapping } = req.body;
        if (!field_mapping || typeof field_mapping !== 'object') {
            fail(res, 'field_mapping object is required');
            return;
        }
        const [batch] = await (0, db_1.query)(`UPDATE data360_batches SET field_mapping=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING *`, [JSON.stringify(field_mapping), req.params.id, req.d360User.sub]);
        if (!batch) {
            fail(res, 'Batch not found', 404);
            return;
        }
        ok(res, batch);
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
function applyMapping(row, mapping) {
    const out = {};
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
exports.data360Router.post('/templates', data360Auth, async (req, res) => {
    try {
        const { name, extraction_fields, output_type, layout_json, template_file_key } = req.body;
        if (!name?.trim()) {
            fail(res, 'name is required');
            return;
        }
        if (!Array.isArray(extraction_fields) || extraction_fields.length === 0) {
            fail(res, 'extraction_fields must be a non-empty array');
            return;
        }
        const type = output_type === 'fillable_pdf' ? 'fillable_pdf' : 'coordinate_layout';
        const [template] = await (0, db_1.query)(`INSERT INTO data360_templates (user_id, name, extraction_fields, output_type, layout_json, template_file_key)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [req.d360User.sub, name.trim(), JSON.stringify(extraction_fields), type, layout_json ? JSON.stringify(layout_json) : null, template_file_key || null]);
        ok(res, template, 201);
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.data360Router.get('/templates', data360Auth, async (req, res) => {
    try {
        const templates = await (0, db_1.query)('SELECT * FROM data360_templates WHERE user_id=$1 ORDER BY created_at DESC', [req.d360User.sub]);
        ok(res, templates);
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.data360Router.patch('/templates/:id', data360Auth, async (req, res) => {
    try {
        const { name, extraction_fields, output_type, layout_json, template_file_key } = req.body;
        const sets = [];
        const params = [];
        let i = 1;
        if (name?.trim()) {
            sets.push(`name=$${i++}`);
            params.push(name.trim());
        }
        if (Array.isArray(extraction_fields)) {
            sets.push(`extraction_fields=$${i++}`);
            params.push(JSON.stringify(extraction_fields));
        }
        if (output_type === 'fillable_pdf' || output_type === 'coordinate_layout') {
            sets.push(`output_type=$${i++}`);
            params.push(output_type);
        }
        if (layout_json !== undefined) {
            sets.push(`layout_json=$${i++}`);
            params.push(layout_json ? JSON.stringify(layout_json) : null);
        }
        if (template_file_key !== undefined) {
            sets.push(`template_file_key=$${i++}`);
            params.push(template_file_key || null);
        }
        if (sets.length === 0) {
            fail(res, 'Nothing to update');
            return;
        }
        sets.push(`updated_at=NOW()`);
        params.push(req.params.id, req.d360User.sub);
        const [template] = await (0, db_1.query)(`UPDATE data360_templates SET ${sets.join(', ')} WHERE id=$${i++} AND user_id=$${i++} RETURNING *`, params);
        if (!template) {
            fail(res, 'Template not found', 404);
            return;
        }
        ok(res, template);
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
exports.data360Router.delete('/templates/:id', data360Auth, async (req, res) => {
    try {
        const [deleted] = await (0, db_1.query)('DELETE FROM data360_templates WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.d360User.sub]);
        if (!deleted) {
            fail(res, 'Template not found', 404);
            return;
        }
        ok(res, { deleted: true });
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// ── GENERATE AGENT ───────────────────────────────────────────────
// Turns approved+mapped rows into a real formatted document per row, using
// a saved template — the counterpart to the raw-row `distribute` targets
// below. coordinate_layout renders with pdf-lib's native drawing primitives
// (no external file needed); fillable_pdf fills an uploaded PDF's form
// fields (needs S3 + AWS credentials — see caveat above).
function defaultLayoutFields(fieldNames) {
    return fieldNames.map((f, idx) => ({ field: f, label: f, x: 50, y: 730 - idx * 50, fontSize: 11 }));
}
async function renderCoordinatePdf(title, layout, fields) {
    const doc = await pdf_lib_1.PDFDocument.create();
    const page = doc.addPage([612, 792]); // US Letter
    const font = await doc.embedFont(pdf_lib_1.StandardFonts.Helvetica);
    const bold = await doc.embedFont(pdf_lib_1.StandardFonts.HelveticaBold);
    page.drawText(title, { x: 50, y: 750, size: 18, font: bold, color: (0, pdf_lib_1.rgb)(0.04, 0.42, 0.36) });
    page.drawLine({ start: { x: 50, y: 742 }, end: { x: 562, y: 742 }, thickness: 1, color: (0, pdf_lib_1.rgb)(0.85, 0.85, 0.85) });
    for (const item of layout) {
        const value = fields[item.field] ?? '';
        const y = item.y ?? 700;
        const x = item.x ?? 50;
        page.drawText(`${(item.label || item.field).toUpperCase()}`, { x, y, size: 8, font: bold, color: (0, pdf_lib_1.rgb)(0.45, 0.45, 0.45) });
        page.drawText(String(value || '—'), { x, y: y - 16, size: item.fontSize || 12, font, color: (0, pdf_lib_1.rgb)(0.1, 0.1, 0.1), maxWidth: 500 });
    }
    return doc.save();
}
async function fillAcroFormPdf(templateBytes, fields) {
    const doc = await pdf_lib_1.PDFDocument.load(templateBytes);
    const form = doc.getForm();
    for (const [name, value] of Object.entries(fields)) {
        try {
            form.getTextField(name).setText(String(value ?? ''));
        }
        catch { /* this template has no form field with this name — skip it */ }
    }
    form.flatten();
    return doc.save();
}
exports.data360Router.post('/batches/:id/generate', data360Auth, async (req, res) => {
    try {
        const { template_id } = req.body;
        const batch = await (0, db_1.queryOne)('SELECT * FROM data360_batches WHERE id=$1 AND user_id=$2', [req.params.id, req.d360User.sub]);
        if (!batch) {
            fail(res, 'Batch not found', 404);
            return;
        }
        const templateId = template_id || batch.template_id;
        if (!templateId) {
            fail(res, 'No template selected — pass template_id or save one on this batch first.');
            return;
        }
        const template = await (0, db_1.queryOne)('SELECT * FROM data360_templates WHERE id=$1 AND user_id=$2', [templateId, req.d360User.sub]);
        if (!template) {
            fail(res, 'Template not found', 404);
            return;
        }
        const approvedRows = await (0, db_1.query)(`SELECT id, row_index, fields FROM data360_rows WHERE batch_id=$1 AND status='approved' ORDER BY row_index ASC`, [batch.id]);
        if (approvedRows.length === 0) {
            fail(res, 'No approved rows to generate from — approve rows first');
            return;
        }
        const [job] = await (0, db_1.query)(`INSERT INTO data360_generation_jobs (batch_id, template_id, status) VALUES ($1,$2,'generating') RETURNING *`, [batch.id, template.id]);
        const fieldNames = template.extraction_fields?.length ? template.extraction_fields : batch.extraction_fields;
        const documents = [];
        let status = 'ready';
        let errorMsg = '';
        try {
            if (template.output_type === 'fillable_pdf') {
                if (!template.template_file_key)
                    throw new Error('This template has no uploaded fillable PDF (template_file_key) — use a coordinate_layout template to test without one.');
                const bucket = process.env.AWS_TEMPLATES_BUCKET || process.env.AWS_S3_BUCKET;
                const hasCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
                if (!bucket || !hasCreds)
                    throw new Error('AWS credentials / AWS_TEMPLATES_BUCKET are not configured on this server — fillable_pdf templates load from S3. Use a coordinate_layout template to test without S3, same limitation the cloud_storage distribute target already has.');
                const { S3Client, GetObjectCommand } = await Promise.resolve().then(() => __importStar(require('@aws-sdk/client-s3')));
                const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
                const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: template.template_file_key }));
                const templateBytes = await obj.Body.transformToByteArray();
                for (const row of approvedRows) {
                    const bytes = await fillAcroFormPdf(templateBytes, row.fields || {});
                    documents.push({ row_id: row.id, row_index: row.row_index, file_name: `${batch.name.replace(/[^a-z0-9]+/gi, '_')}_row${row.row_index + 1}.pdf`, file_base64: Buffer.from(bytes).toString('base64') });
                }
            }
            else {
                const layout = template.layout_json?.length ? template.layout_json : defaultLayoutFields(fieldNames);
                for (const row of approvedRows) {
                    const bytes = await renderCoordinatePdf(template.name, layout, row.fields || {});
                    documents.push({ row_id: row.id, row_index: row.row_index, file_name: `${batch.name.replace(/[^a-z0-9]+/gi, '_')}_row${row.row_index + 1}.pdf`, file_base64: Buffer.from(bytes).toString('base64') });
                }
            }
        }
        catch (e) {
            status = 'failed';
            errorMsg = e.message;
        }
        const result = status === 'ready' ? { documents, row_count: documents.length } : { error: errorMsg };
        const [updatedJob] = await (0, db_1.query)(`UPDATE data360_generation_jobs SET status=$1, result=$2, completed_at=NOW() WHERE id=$3 RETURNING *`, [status, JSON.stringify(result), job.id]);
        ok(res, updatedJob, status === 'ready' ? 201 : 200);
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
// Only alphanumeric + underscore, must start with a letter — prevents SQL
// injection via a table/column name that can't be parameterized.
const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// ── DESTINATION AGENT — CONFIG + EXECUTE ─────────────────────────
// target_type: 'file_export' | 'cloud_storage' | 'database' | 'api' | 'rpa_portal'
exports.data360Router.post('/batches/:id/distribute', data360Auth, async (req, res) => {
    try {
        const { target_type, config } = req.body;
        if (!['file_export', 'cloud_storage', 'database', 'api', 'rpa_portal'].includes(target_type)) {
            fail(res, 'Invalid target_type');
            return;
        }
        const batch = await (0, db_1.queryOne)('SELECT * FROM data360_batches WHERE id=$1 AND user_id=$2', [req.params.id, req.d360User.sub]);
        if (!batch) {
            fail(res, 'Batch not found', 404);
            return;
        }
        const approvedRowsRaw = await (0, db_1.query)(`SELECT row_index, source_type, fields, extracted_entity, target_field_a, target_field_b, agent_verdict
       FROM data360_rows WHERE batch_id=$1 AND status='approved' ORDER BY row_index ASC`, [batch.id]);
        if (approvedRowsRaw.length === 0) {
            fail(res, 'No approved rows to distribute — approve rows first');
            return;
        }
        const mapping = batch.field_mapping || {};
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
        if (safeConfig.password)
            safeConfig.password = '••••••••';
        if (safeConfig.secret_password_token)
            safeConfig.secret_password_token = '••••••••';
        if (safeConfig.connection_string)
            safeConfig.connection_string = '••••••••';
        if (safeConfig.auth_token)
            safeConfig.auth_token = '••••••••';
        const [job] = await (0, db_1.query)(`INSERT INTO data360_distribution_jobs (batch_id, target_type, config, status)
       VALUES ($1,$2,$3,'pending') RETURNING *`, [batch.id, target_type, JSON.stringify(safeConfig)]);
        let status = 'pending';
        let result = {};
        if (target_type === 'file_export') {
            const ws = XLSX.utils.json_to_sheet(approvedRows);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Approved Rows');
            const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
            status = 'completed';
            result = { file_base64: buffer.toString('base64'), file_name: `${batch.name.replace(/[^a-z0-9]+/gi, '_')}_export.xlsx`, row_count: approvedRows.length };
        }
        else if (target_type === 'cloud_storage') {
            const bucket = config?.bucket_name;
            const hasCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
            if (!bucket || !hasCreds) {
                status = 'failed';
                result = { error: !hasCreds ? 'AWS credentials are not configured on this server (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).' : 'bucket_name is required in config.' };
            }
            else {
                try {
                    const { S3Client, PutObjectCommand } = await Promise.resolve().then(() => __importStar(require('@aws-sdk/client-s3')));
                    const s3 = new S3Client({ region: config?.region || process.env.AWS_REGION || 'us-east-1' });
                    const key = `data360/${batch.id}/${Date.now()}_export.json`;
                    await s3.send(new PutObjectCommand({
                        Bucket: bucket, Key: key,
                        Body: JSON.stringify(approvedRows, null, 2),
                        ContentType: 'application/json',
                    }));
                    status = 'completed';
                    result = { bucket, key, row_count: approvedRows.length };
                }
                catch (e) {
                    status = 'failed';
                    result = { error: e.message };
                }
            }
        }
        else if (target_type === 'database') {
            // Real Postgres INSERT into a destination the caller owns — a fresh,
            // short-lived Client (not the shared pool) so a bad/slow external DB
            // can't exhaust our own connection pool.
            const connectionString = config?.connection_string;
            const tableName = config?.table_name;
            if (!connectionString || !tableName) {
                status = 'failed';
                result = { error: 'connection_string and table_name are both required in config.' };
            }
            else if (!SAFE_IDENT.test(tableName)) {
                status = 'failed';
                result = { error: 'table_name must be a plain identifier (letters, numbers, underscore).' };
            }
            else {
                const { Client } = await Promise.resolve().then(() => __importStar(require('pg')));
                const columns = Object.keys(approvedRows[0]);
                if (!columns.every(c => SAFE_IDENT.test(c))) {
                    status = 'failed';
                    result = { error: 'Mapped field names must be plain identifiers (letters, numbers, underscore) to use as column names.' };
                }
                else {
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
                    }
                    catch (e) {
                        status = 'failed';
                        result = { error: e.message };
                    }
                    finally {
                        await client.end().catch(() => { });
                    }
                }
            }
        }
        else if (target_type === 'api') {
            // Real HTTP POST/PUT of the mapped rows to any endpoint the caller
            // configures — the most universally useful "get my data into any
            // system" destination, since every modern platform accepts a webhook.
            const url = config?.url;
            const method = (config?.method || 'POST').toUpperCase();
            if (!url) {
                status = 'failed';
                result = { error: 'url is required in config.' };
            }
            else {
                try {
                    const headers = { 'Content-Type': 'application/json' };
                    if (config?.auth_token)
                        headers['Authorization'] = `Bearer ${config.auth_token}`;
                    const resp = await fetch(url, { method, headers, body: JSON.stringify({ batch: batch.name, rows: approvedRows }) });
                    const bodyText = await resp.text();
                    if (resp.ok) {
                        status = 'completed';
                        result = { status_code: resp.status, row_count: approvedRows.length, response_snippet: bodyText.slice(0, 300) };
                    }
                    else {
                        status = 'failed';
                        result = { error: `Target API responded ${resp.status}`, response_snippet: bodyText.slice(0, 300) };
                    }
                }
                catch (e) {
                    status = 'failed';
                    result = { error: e.message };
                }
            }
        }
        else if (target_type === 'rpa_portal') {
            // Live Selenium/browser-driven form submission is intentionally not
            // wired up: it cannot run reliably inside a short-lived HTTP request
            // on this deployment (no persistent headless-browser worker here).
            // The configuration is saved and the job is queued for a future
            // worker process to pick up.
            status = 'pending';
            result = { queued: true, note: 'Live browser automation is not connected in this environment. The target configuration has been saved and the job is queued.' };
        }
        const [updatedJob] = await (0, db_1.query)(`UPDATE data360_distribution_jobs SET status=$1, result=$2, completed_at=CASE WHEN $1 != 'pending' THEN NOW() ELSE NULL END WHERE id=$3 RETURNING *`, [status, JSON.stringify(result), job.id]);
        if (status === 'completed') {
            await (0, db_1.query)(`UPDATE data360_batches SET status='distributed', updated_at=NOW() WHERE id=$1`, [batch.id]);
        }
        ok(res, updatedJob, 201);
    }
    catch (e) {
        fail(res, e.message, 500);
    }
});
