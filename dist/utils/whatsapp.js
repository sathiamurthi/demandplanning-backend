"use strict";
/**
 * WhatsApp notifications via Meta Cloud API (WhatsApp Business Platform).
 *
 * Configure in .env:
 *   ENABLE_WHATSAPP=true
 *   WHATSAPP_API_VERSION=v21.0
 *   WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
 *   WHATSAPP_ACCESS_TOKEN=your_permanent_token
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeWhatsAppPhone = normalizeWhatsAppPhone;
exports.sendWhatsAppText = sendWhatsAppText;
exports.sendRegistrationWhatsApp = sendRegistrationWhatsApp;
exports.sendPasswordResetWhatsApp = sendPasswordResetWhatsApp;
const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
function isEnabled() {
    return process.env.ENABLE_WHATSAPP === 'true' && !!PHONE_NUMBER_ID && !!ACCESS_TOKEN;
}
/** Normalize to digits only; Meta API expects country code without + */
function normalizeWhatsAppPhone(phone) {
    return phone.replace(/\D/g, '');
}
async function sendWhatsAppText(to, body) {
    const phone = normalizeWhatsAppPhone(to);
    if (!phone)
        return { sent: false, error: 'Invalid phone number' };
    if (!isEnabled()) {
        console.log('[whatsapp:DEV] Would send →', { to: phone, body });
        return { sent: false, skipped: true };
    }
    const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: phone,
                type: 'text',
                text: { preview_url: false, body },
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const errMsg = data?.error?.message || `HTTP ${res.status}`;
            console.error('[whatsapp] Send failed:', errMsg);
            return { sent: false, error: errMsg };
        }
        const messageId = data?.messages?.[0]?.id;
        console.log('[whatsapp] Sent:', messageId);
        return { sent: true, messageId };
    }
    catch (e) {
        console.error('[whatsapp] Error:', e.message);
        return { sent: false, error: e.message };
    }
}
async function sendRegistrationWhatsApp(phone, firstName, companyName, planType) {
    const name = firstName || 'there';
    const frontendUrl = (process.env.PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL || 'https://demandgenius.vercel.app').split(',')[0];
    const plan = (planType || 'free').charAt(0).toUpperCase() + (planType || 'free').slice(1);
    const business = companyName ? companyName : 'your business';
    const msg = [
        `Hi ${name}! Welcome to DemandGenius 🎉`,
        ``,
        `Your account is ready:`,
        `🏢 Business: ${business}`,
        `💎 Plan: ${plan}`,
        `🔗 Login: ${frontendUrl}/login`,
        ``,
        `Sign in with your phone number and password.`,
        `Need help? Reply to this message anytime.`,
    ].join('\n');
    return sendWhatsAppText(phone, msg);
}
async function sendPasswordResetWhatsApp(phone, resetToken) {
    const frontendUrl = (process.env.PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL || 'https://demandgenius.vercel.app').split(',')[0];
    const link = `${frontendUrl}/reset-password?token=${resetToken}`;
    return sendWhatsAppText(phone, `DemandGenius password reset: ${link}\nThis link expires in 1 hour. If you did not request this, ignore this message.`);
}
