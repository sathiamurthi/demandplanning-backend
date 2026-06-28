// ============================================================
// Meta / WhatsApp Cloud API — Central Configuration
// All WhatsApp bot behaviour is controlled from this file.
// Credentials come from environment variables (never hardcode).
// ============================================================

export interface MetaConfig {
  // ── Credentials ──────────────────────────────────────────
  apiVersion:     string;
  phoneNumberId:  string;
  accessToken:    string;
  appSecret:      string;
  verifyToken:    string;
  appId:          string;
  wabaId:         string;

  // ── App URLs (used in footer of every bot message) ───────
  appUrl:         string;   // base URL, e.g. https://yourdomain.com
  exploreUrl:     string;   // appUrl + /explore
  loginUrl:       string;   // appUrl + /login

  // ── Bot Behaviour ─────────────────────────────────────────
  bot: {
    showPhoneNumbers:    boolean;  // false = paid feature only
    maxPublicResults:    number;   // max items in public search
    maxPrivateResults:   number;   // max items in private (logged-in) search
    maxStoreResults:     number;   // max stores in explore list
    maxLowStockResults:  number;   // max low-stock items shown
    sessionTimeoutDays:  number;   // (future) auto-logout after N days idle
  };

  // ── Webhook ───────────────────────────────────────────────
  webhook: {
    path:       string;   // Express route path
    fullUrl:    string;   // public HTTPS URL Meta calls
  };

  // ── Feature Flags ─────────────────────────────────────────
  features: {
    enabled:        boolean;  // master switch — false = no WhatsApp at all
    publicSearch:   boolean;  // allow searching without login
    exploreStores:  boolean;  // allow listing stores without login
    requireSession: boolean;  // if true, ALL commands need login
  };
}

// ── Build config from environment ────────────────────────────
function buildConfig(): MetaConfig {
  // Webhook endpoint: the public HTTPS URL Meta calls (ngrok in dev, backend domain in prod)
  const webhookBase = (process.env.PUBLIC_APP_URL || 'https://demandgenius.vercel.app').replace(/\/$/, '');

  // User-facing links sent inside WhatsApp messages — always the Vercel frontend
  const appUrl = (process.env.PUBLIC_FRONTEND_URL || 'https://demandgenius.vercel.app').replace(/\/$/, '');

  return {
    // Credentials
    apiVersion:    process.env.WHATSAPP_API_VERSION    || 'v25.0',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken:   process.env.WHATSAPP_ACCESS_TOKEN    || '',
    appSecret:     process.env.WHATSAPP_APP_SECRET      || '',
    verifyToken:   process.env.WHATSAPP_VERIFY_TOKEN    || 'demandplanning_wa_verify',
    appId:         process.env.WHATSAPP_APP_ID          || '',
    wabaId:        process.env.WHATSAPP_WABA_ID         || '',

    // URLs
    appUrl,
    exploreUrl: `${appUrl}/explore`,
    loginUrl:   appUrl,

    // Bot behaviour
    bot: {
      showPhoneNumbers:   false,   // phone numbers are a paid feature
      maxPublicResults:   10,
      maxPrivateResults:  8,
      maxStoreResults:    12,
      maxLowStockResults: 15,
      sessionTimeoutDays: 30,
    },

    // Webhook — uses the backend public URL (ngrok in dev), NOT the frontend URL
    webhook: {
      path:    '/v1/webhooks/whatsapp',
      fullUrl: `${webhookBase}/v1/webhooks/whatsapp`,
    },

    // Feature flags
    features: {
      enabled:        process.env.ENABLE_WHATSAPP === 'true',
      publicSearch:   true,
      exploreStores:  true,
      requireSession: false,
    },
  };
}

// Singleton — imported everywhere in the whatsapp module
export const metaConfig: MetaConfig = buildConfig();

// ── Helpers ───────────────────────────────────────────────────

/** Standard footer appended to every bot message */
export function botFooter(hint?: string): string {
  const tip = hint ? `\n_${hint}_\n` : '';
  return `${tip}\n🌐 *Browse stores:* ${metaConfig.exploreUrl}\n🔐 *Full access:* ${metaConfig.loginUrl}`;
}

/** True when credentials are configured (non-empty) */
export function isWhatsAppConfigured(): boolean {
  return Boolean(metaConfig.phoneNumberId && metaConfig.accessToken);
}

/** App access token — used for webhook subscription API calls */
export function appAccessToken(): string {
  return `${metaConfig.appId}|${metaConfig.appSecret}`;
}
