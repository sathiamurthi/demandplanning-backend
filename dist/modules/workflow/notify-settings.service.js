"use strict";
// ============================================================
// Notification Settings — OTP verification for WhatsApp & Email
// Routes: /v1/public/notify-settings/*
// ============================================================
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
exports.notifySettingsRouter = void 0;
const express_1 = require("express");
const nodemailer_1 = __importDefault(require("nodemailer"));
const db_1 = require("../../config/db");
const whatsapp_1 = require("../../utils/whatsapp");
exports.notifySettingsRouter = (0, express_1.Router)();
function ok(res, data, status = 200) {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res, msg, status = 400) {
    res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}
// ── OTP generator ─────────────────────────────────────────────
function genOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
}
// ── Email transporter ─────────────────────────────────────────
function getMailer() {
    return nodemailer_1.default.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER || '',
            pass: process.env.SMTP_PASS || '',
        },
    });
}
async function sendEmailOtp(to, otp) {
    const mailer = getMailer();
    await mailer.sendMail({
        from: `"${process.env.SMTP_FROM_NAME || 'DemandGenius'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to,
        subject: `Your DemandGenius verification code: ${otp}`,
        text: `Your verification code is: ${otp}\n\nThis code expires in 10 minutes.\n\nIf you did not request this, ignore this email.`,
        html: `
      <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px">
        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:24px;text-align:center">
          <p style="font-size:14px;color:#6b7280;margin-bottom:8px">Your DemandGenius verification code</p>
          <p style="font-size:36px;font-weight:900;color:#ea580c;letter-spacing:8px;margin:0">${otp}</p>
          <p style="font-size:12px;color:#9ca3af;margin-top:12px">Expires in 10 minutes</p>
        </div>
        <p style="font-size:11px;color:#d1d5db;text-align:center;margin-top:16px">If you did not request this, you can safely ignore this email.</p>
      </div>
    `,
    });
}
// ── Upsert OTP (rate-limited: 1 per minute) ──────────────────
async function upsertOtp(type, identifier, guestId) {
    const otp = genOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    // Rate-limit: block if last OTP was sent < 60 seconds ago
    const existing = await (0, db_1.queryOne)(`SELECT created_at FROM otp_verifications WHERE type=$1 AND identifier=$2`, [type, identifier]);
    if (existing) {
        const age = Date.now() - new Date(existing.created_at).getTime();
        if (age < 60000) {
            throw new Error('Please wait before requesting another OTP');
        }
    }
    await (0, db_1.query)(`INSERT INTO otp_verifications (type, identifier, otp_code, guest_id, expires_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (type, identifier) DO UPDATE
       SET otp_code=$3, guest_id=$4, expires_at=$5, verified_at=NULL, created_at=NOW()`, [type, identifier, otp, guestId, expiresAt]);
    return otp;
}
// ── POST /v1/public/notify-settings/send-wa-otp ──────────────
exports.notifySettingsRouter.post('/send-wa-otp', async (req, res) => {
    try {
        const { phone, guest_id } = req.body;
        if (!phone?.trim() || !guest_id?.trim())
            return fail(res, 'phone and guest_id are required');
        const normalized = (0, whatsapp_1.normalizeWhatsAppPhone)(phone.trim());
        if (normalized.length < 10)
            return fail(res, 'Invalid phone number');
        const otp = await upsertOtp('whatsapp', normalized, guest_id);
        const result = await (0, whatsapp_1.sendWhatsAppText)(normalized, `🔐 *DemandGenius Verification*\n\nYour OTP is: *${otp}*\n\n_Expires in 10 minutes. Do not share this code with anyone._`);
        if (!result.sent && !result.skipped) {
            return fail(res, result.error || 'Failed to send WhatsApp OTP');
        }
        return ok(res, { sent: true, skipped: result.skipped || false, hint: result.skipped ? 'Dev mode: OTP logged to console' : undefined });
    }
    catch (e) {
        return fail(res, e.message);
    }
});
// ── POST /v1/public/notify-settings/verify-wa-otp ────────────
exports.notifySettingsRouter.post('/verify-wa-otp', async (req, res) => {
    try {
        const { phone, otp, guest_id } = req.body;
        if (!phone || !otp || !guest_id)
            return fail(res, 'phone, otp and guest_id are required');
        const normalized = (0, whatsapp_1.normalizeWhatsAppPhone)(phone.trim());
        const row = await (0, db_1.queryOne)(`SELECT * FROM otp_verifications WHERE type='whatsapp' AND identifier=$1`, [normalized]);
        if (!row)
            return fail(res, 'OTP not found. Please request a new code.', 404);
        if (row.verified_at)
            return fail(res, 'OTP already used. Request a new code.');
        if (new Date(row.expires_at) < new Date())
            return fail(res, 'OTP expired. Request a new code.');
        if (row.otp_code !== String(otp).trim())
            return fail(res, 'Incorrect OTP. Please try again.');
        // Mark OTP verified
        await (0, db_1.query)(`UPDATE otp_verifications SET verified_at=NOW() WHERE type='whatsapp' AND identifier=$1`, [normalized]);
        // Upsert notification preference
        await (0, db_1.query)(`INSERT INTO notification_preferences (guest_id, whatsapp_phone, whatsapp_verified, whatsapp_verified_at)
       VALUES ($1,$2,TRUE,NOW())
       ON CONFLICT (guest_id) DO UPDATE
         SET whatsapp_phone=$2, whatsapp_verified=TRUE, whatsapp_verified_at=NOW(), updated_at=NOW()`, [guest_id, normalized]);
        // Send confirmation
        await (0, whatsapp_1.sendWhatsAppText)(normalized, `✅ *WhatsApp verified!*\n\nYour number is now connected to DemandGenius. You'll receive booking updates and notifications here.`);
        return ok(res, { verified: true, phone: normalized });
    }
    catch (e) {
        return fail(res, e.message);
    }
});
// ── POST /v1/public/notify-settings/send-email-otp ───────────
exports.notifySettingsRouter.post('/send-email-otp', async (req, res) => {
    try {
        const { email, guest_id } = req.body;
        if (!email?.trim() || !guest_id?.trim())
            return fail(res, 'email and guest_id are required');
        const normalized = email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
            return fail(res, 'Invalid email address');
        const otp = await upsertOtp('email', normalized, guest_id);
        await sendEmailOtp(normalized, otp);
        return ok(res, { sent: true });
    }
    catch (e) {
        return fail(res, e.message);
    }
});
// ── POST /v1/public/notify-settings/verify-email-otp ─────────
exports.notifySettingsRouter.post('/verify-email-otp', async (req, res) => {
    try {
        const { email, otp, guest_id } = req.body;
        if (!email || !otp || !guest_id)
            return fail(res, 'email, otp and guest_id are required');
        const normalized = email.trim().toLowerCase();
        const row = await (0, db_1.queryOne)(`SELECT * FROM otp_verifications WHERE type='email' AND identifier=$1`, [normalized]);
        if (!row)
            return fail(res, 'OTP not found. Please request a new code.', 404);
        if (row.verified_at)
            return fail(res, 'OTP already used. Request a new code.');
        if (new Date(row.expires_at) < new Date())
            return fail(res, 'OTP expired. Request a new code.');
        if (row.otp_code !== String(otp).trim())
            return fail(res, 'Incorrect OTP. Please try again.');
        await (0, db_1.query)(`UPDATE otp_verifications SET verified_at=NOW() WHERE type='email' AND identifier=$1`, [normalized]);
        await (0, db_1.query)(`INSERT INTO notification_preferences (guest_id, email, email_verified, email_verified_at)
       VALUES ($1,$2,TRUE,NOW())
       ON CONFLICT (guest_id) DO UPDATE
         SET email=$2, email_verified=TRUE, email_verified_at=NOW(), updated_at=NOW()`, [guest_id, normalized]);
        return ok(res, { verified: true, email: normalized });
    }
    catch (e) {
        return fail(res, e.message);
    }
});
// ── POST /v1/public/notify-settings/wa-register ──────────────
// Triggers Puppeteer to add phone to WA dev console test recipients.
// Only runs when ENABLE_WA_PUPPETEER=true (dev/test environments only).
exports.notifySettingsRouter.post('/wa-register', async (req, res) => {
    if (process.env.ENABLE_WA_PUPPETEER !== 'true') {
        return ok(res, { skipped: true, reason: 'Puppeteer registration disabled in this environment' });
    }
    const { phone } = req.body;
    if (!phone)
        return fail(res, 'phone is required');
    const { execFile } = await Promise.resolve().then(() => __importStar(require('child_process')));
    const path = await Promise.resolve().then(() => __importStar(require('path')));
    const scriptPath = path.join(__dirname, '../../../../scripts/wa-add-recipient.js');
    return new Promise((resolve) => {
        execFile('node', [scriptPath, phone], { timeout: 60000 }, (err, stdout, stderr) => {
            if (err) {
                console.error('[wa-register] Puppeteer error:', stderr || err.message);
                fail(res, `Registration failed: ${err.message}`);
            }
            else {
                console.log('[wa-register]', stdout);
                ok(res, { registered: true, phone, log: stdout });
            }
            resolve();
        });
    });
});
// ── GET /v1/public/notify-settings?guest_id=xxx ──────────────
exports.notifySettingsRouter.get('/', async (req, res) => {
    try {
        const guestId = String(req.query.guest_id || '');
        if (!guestId)
            return fail(res, 'guest_id is required');
        const row = await (0, db_1.queryOne)(`SELECT whatsapp_phone, whatsapp_verified, whatsapp_verified_at,
              email, email_verified, email_verified_at, updated_at
       FROM notification_preferences WHERE guest_id=$1`, [guestId]);
        return ok(res, row || { whatsapp_phone: null, whatsapp_verified: false, email: null, email_verified: false });
    }
    catch (e) {
        return fail(res, e.message);
    }
});
