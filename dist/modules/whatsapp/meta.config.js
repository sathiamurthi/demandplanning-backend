"use strict";
// ============================================================
// Meta / WhatsApp Cloud API — Central Configuration
// All WhatsApp bot behaviour is controlled from this file.
// Credentials come from environment variables (never hardcode).
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.metaConfig = void 0;
exports.botFooter = botFooter;
exports.isWhatsAppConfigured = isWhatsAppConfigured;
exports.appAccessToken = appAccessToken;
// ── Build config from environment ────────────────────────────
function buildConfig() {
    // Webhook endpoint: the public HTTPS URL Meta calls (ngrok in dev, backend domain in prod)
    const webhookBase = (process.env.PUBLIC_APP_URL || 'https://demandgenius.vercel.app').replace(/\/$/, '');
    // User-facing links sent inside WhatsApp messages — always the Vercel frontend
    const appUrl = (process.env.PUBLIC_FRONTEND_URL || 'https://demandgenius.vercel.app').replace(/\/$/, '');
    return {
        // Credentials
        apiVersion: process.env.WHATSAPP_API_VERSION || 'v25.0',
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
        appSecret: process.env.WHATSAPP_APP_SECRET || '',
        verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'demandplanning_wa_verify',
        appId: process.env.WHATSAPP_APP_ID || '',
        wabaId: process.env.WHATSAPP_WABA_ID || '',
        // URLs
        appUrl,
        exploreUrl: `${appUrl}/explore`,
        loginUrl: appUrl,
        // Bot behaviour
        bot: {
            showPhoneNumbers: false, // phone numbers are a paid feature
            maxPublicResults: 10,
            maxPrivateResults: 8,
            maxStoreResults: 12,
            maxLowStockResults: 15,
            sessionTimeoutDays: 30,
        },
        // Webhook — uses the backend public URL (ngrok in dev), NOT the frontend URL
        webhook: {
            path: '/v1/webhooks/whatsapp',
            fullUrl: `${webhookBase}/v1/webhooks/whatsapp`,
        },
        // Feature flags
        features: {
            enabled: process.env.ENABLE_WHATSAPP === 'true',
            publicSearch: true,
            exploreStores: true,
            requireSession: false,
        },
    };
}
// Singleton — imported everywhere in the whatsapp module
exports.metaConfig = buildConfig();
// ── Helpers ───────────────────────────────────────────────────
/** Standard footer appended to every bot message */
function botFooter(hint) {
    const tip = hint ? `\n_${hint}_\n` : '';
    return `${tip}\n🌐 *Browse stores:* ${exports.metaConfig.exploreUrl}\n🔐 *Full access:* ${exports.metaConfig.loginUrl}`;
}
/** True when credentials are configured (non-empty) */
function isWhatsAppConfigured() {
    return Boolean(exports.metaConfig.phoneNumberId && exports.metaConfig.accessToken);
}
/** App access token — used for webhook subscription API calls */
function appAccessToken() {
    return `${exports.metaConfig.appId}|${exports.metaConfig.appSecret}`;
}
