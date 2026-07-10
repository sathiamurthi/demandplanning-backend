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
exports.app = void 0;
// ============================================================
// app.ts — Express application — all modules wired v2
// ============================================================
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const logger_1 = require("./config/logger");
const path_1 = __importDefault(require("path"));
// Resolve .env relative to the current file directory
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, "../.env") });
// ── Auth ──────────────────────────────────────────────────────
const auth_service_1 = require("./modules/auth/auth.service");
// ── Core modules ─────────────────────────────────────────────
const tenants_service_1 = require("./modules/auth/tenants.service");
const stores_service_1 = require("./modules/auth/stores.service");
const items_service_1 = require("./modules/auth/items.service");
const sales_service_1 = require("./modules/auth/sales.service");
const coupons_service_1 = require("./modules/auth/coupons.service");
// ── Dedicated modules ─────────────────────────────────────────
const industry_service_1 = require("./modules/auth/industry.service");
const ai_service_1 = require("./modules/auth/ai.service");
const alerts_service_1 = require("./modules/auth/alerts.service");
const categories_service_1 = require("./modules/auth/categories.service");
// ── Supporting routers from billing file ─────────────────────
const billing_service_1 = require("./modules/auth/billing.service");
const units_service_1 = require("./modules/auth/units.service");
const suppliers_service_1 = require("./modules/auth/suppliers.service");
const purchase_orders_service_1 = require("./modules/auth/purchase-orders.service");
const health_1 = require("./modules/auth/health");
const public_service_1 = require("./modules/auth/public.service");
// ── Superadmin module ─────────────────────────────────────────
const superadmin_controller_1 = __importDefault(require("./modules/superadmin/superadmin.controller"));
require("./modules/superadmin/superadmin.service");
require("./modules/tenants/handlers/index");
const tenant_router_1 = __importDefault(require("./modules/tenants/tenant.router"));
require("./interface/index");
const registertenant_router_1 = __importDefault(require("./interface/tenants/registertenant.router"));
const users_1 = __importDefault(require("./modules/tenants/routers/users"));
const generic_router_1 = __importDefault(require("./modules/core/api/generic.router"));
const route_1 = __importDefault(require("./dashboard/route/route"));
const swagger_1 = require("./config/swagger");
const search_service_1 = require("./modules/public/search.service");
const hotel_response_service_1 = require("./modules/auth/hotel-response.service");
const tea_service_1 = require("./modules/tea/tea.service");
const whatsapp_webhook_1 = require("./modules/whatsapp/whatsapp.webhook");
const workflow_service_1 = require("./modules/workflow/workflow.service");
const notify_settings_service_1 = require("./modules/workflow/notify-settings.service");
const college360_router_1 = require("./modules/college360/college360.router");
// ── Create app ───────────────────────────────────────────────
exports.app = (0, express_1.default)();
// ── Security middleware ──────────────────────────────────────
exports.app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
// ── Unified CORS configuration ───────────────────────────────
exports.app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        const allowed = (process.env.FRONTEND_URL || 'http://localhost:4000,http://localhost:5173').split(',').map(s => s.trim());
        const trusted = !origin
            || allowed.includes(origin)
            || process.env.NODE_ENV === 'development'
            || /\.vercel\.app$/.test(origin)
            || /\.ngrok(-free)?\.app$/.test(origin)
            || /\.ngrok\.io$/.test(origin)
            || /\.onrender\.com$/.test(origin);
        if (trusted) {
            callback(null, true);
        }
        else {
            callback(new Error('CORS not allowed'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key'],
}));
// ── WhatsApp webhook — raw body capture BEFORE json parser ───
// Meta requires HMAC-SHA256 verification against the raw payload
exports.app.use('/v1/webhooks/whatsapp', express_1.default.raw({ type: 'application/json' }), (req, _res, next) => {
    req.rawBody = req.body;
    try {
        req.body = JSON.parse(req.body.toString());
    }
    catch {
        req.body = {};
    }
    next();
});
exports.app.use('/v1/webhooks/whatsapp', whatsapp_webhook_1.waWebhookRouter);
// ── Body parsers ─────────────────────────────────────────────
exports.app.use(express_1.default.json({ limit: '5mb' }));
exports.app.use(express_1.default.json());
exports.app.use(express_1.default.urlencoded({ extended: true }));
// ── Global rate limit ────────────────────────────────────────
exports.app.use((0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX || '500'),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many requests, please try again later.' },
}));
// ── Request logger ───────────────────────────────────────────
exports.app.use((req, _res, next) => {
    logger_1.logger.debug(`${req.method} ${req.path}`, { ip: req.ip, query: req.query });
    next();
});
// ── Health check — must return 200 immediately (no DB) ───────
exports.app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'genericdemandai-api', version: '2.0.0' });
});
// /v1/health handled by healthRouter below — returns 200 immediately
// ── CQRS bus status (superadmin debug) ───────────────────────
exports.app.get('/v1/debug/commands', auth_service_1.authMiddleware, async (req, res) => {
    if (req.user?.role !== 'superadmin') {
        res.status(403).json({ error: 'Forbidden' });
        return;
    }
    const { commandBus } = await Promise.resolve().then(() => __importStar(require('./cqrs/commandBus')));
    const { queryBus } = await Promise.resolve().then(() => __importStar(require('./cqrs/queryBus')));
    res.json({
        commands: commandBus.getRegisteredCommands(),
        //queries:  queryBus.getRegisteredQueries(),
    });
});
exports.app.use('/v1', health_1.healthRouter);
exports.app.use('/v1/api-docs', swagger_1.swaggerRouter);
exports.app.use('/v1/ext/tenant', registertenant_router_1.default);
// ── PUBLIC ───────────────────────────────────────────────────
exports.app.use('/v1/ext/stores', public_service_1.publicRouter);
exports.app.use('/v1/public', search_service_1.publicSearchRouter);
exports.app.use('/v1/public/hotel-response', hotel_response_service_1.hotelResponseRouter);
exports.app.use('/v1/public', workflow_service_1.workflowRouter);
exports.app.use('/v1/public/notify-settings', notify_settings_service_1.notifySettingsRouter);
exports.app.use('/v1/c360', college360_router_1.c360Router);
exports.app.use('/v1/auth', auth_service_1.authRouter);
exports.app.use('/v1/units', units_service_1.unitsRouter);
exports.app.use('/v1/industries', industry_service_1.industryRouter);
exports.app.use('/v1/tenants/:tenantId/stores', route_1.default);
exports.app.use('/v1/tenants/:tenantId/dashboard', auth_service_1.authMiddleware, tenant_router_1.default);
exports.app.use('/v1/ext/tenants', generic_router_1.default);
exports.app.use('/v1/entity/tenants/:tenantId', generic_router_1.default);
exports.app.use('/v1/tenants/:tenantId/stores', stores_service_1.storeRouter);
// ── PROTECTED — specific tenant sub-routes first, then general tenantRouter ──
exports.app.use('/v1/tenants/:tenantId/coupons', coupons_service_1.couponsRouter); // ← BEFORE tenantRouter
exports.app.use('/v1/tenants/:tenantId/users', users_1.default);
exports.app.use('/v1/tenants/:tenantId/categories', categories_service_1.categoryRouter);
exports.app.use('/v1/tenants/:tenantId/suppliers', suppliers_service_1.suppliersRouter);
exports.app.use('/v1/tenants/:tenantId/purchase-orders', purchase_orders_service_1.purchaseOrdersRouter);
exports.app.use('/v1/tenants/:tenantId/stores/:storeId/items', items_service_1.itemRouter);
exports.app.use('/v1/tenants', tenants_service_1.tenantRouter); // ← AFTER specifics
exports.app.use('/v1/stores/:storeId/sales', auth_service_1.authMiddleware, sales_service_1.salesRouter);
exports.app.use('/v1/stores/:storeId/report', auth_service_1.authMiddleware, ai_service_1.aiRouter);
exports.app.use('/v1/tenants/:tenantId/ai-settings', ai_service_1.aiSettingsRouter);
exports.app.use('/v1/alerts', alerts_service_1.alertRouter);
exports.app.use('/v1/billing', billing_service_1.billingRouter);
// app.use('/v1/dashboard',               dashboardRouter);
// ── TEA MODULE ───────────────────────────────────────────────
exports.app.use('/v1/tenants/:tenantId/tea', tea_service_1.teaRouter);
// ── SUPERADMIN ROUTER ────────────────────────────────────────
exports.app.use('/v1/superadmin', auth_service_1.authMiddleware, superadmin_controller_1.default);
exports.app.use('/v1/superadmin/coupons', auth_service_1.authMiddleware, coupons_service_1.superadminCouponsRouter);
// ── Request logger ───────────────────────────────────────────
if (process.env.LOG_API_CALLS === 'true') {
    exports.app.use((req, res, next) => {
        logger_1.logger.info(`API CALL: ${req.method} ${req.originalUrl}`, {
            ip: req.ip,
            query: req.query,
            body: req.body,
        });
        next();
    });
}
// ── 404 handler ──────────────────────────────────────────────
exports.app.use((_req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found', timestamp: new Date().toISOString() });
});
// ── Global error handler ─────────────────────────────────────
exports.app.use((err, _req, res, _next) => {
    logger_1.logger.error('Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, error: err.message || 'Internal server error', timestamp: new Date().toISOString() });
});
