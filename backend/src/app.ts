// ============================================================
// app.ts — Express application — all modules wired v2
// ============================================================
import dotenv from 'dotenv';
import express, { Request, Response, NextFunction, application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { logger } from './config/logger';
import path from "path";

// Resolve .env relative to the current file directory
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// ── Auth ──────────────────────────────────────────────────────
import { authRouter, authMiddleware } from './modules/auth/auth.service';
// ── Core modules ─────────────────────────────────────────────
import { tenantRouter }              from './modules/auth/tenants.service';
import { storeRouter }               from './modules/auth/stores.service';
import { itemRouter }                from './modules/auth/items.service';
import { salesRouter }               from './modules/auth/sales.service';
import { couponsRouter, superadminCouponsRouter } from './modules/auth/coupons.service';
// ── Dedicated modules ─────────────────────────────────────────
import { industryRouter }            from './modules/auth/industry.service';
import { aiRouter, aiSettingsRouter } from './modules/auth/ai.service';
import { alertRouter }               from './modules/auth/alerts.service';
import { categoryRouter }            from './modules/auth/categories.service';
// ── Supporting routers from billing file ─────────────────────
import { billingRouter }
                                     from './modules/auth/billing.service';
import { unitsRouter }
                                     from './modules/auth/units.service';
import { suppliersRouter }            from './modules/auth/suppliers.service';
import { purchaseOrdersRouter }      from './modules/auth/purchase-orders.service';
import { healthRouter } from './modules/auth/health';
import { publicRouter } from './modules/auth/public.service';

// ── Superadmin module ─────────────────────────────────────────
import superadminRouter from './modules/superadmin/superadmin.controller';

import  './modules/superadmin/superadmin.service';
import "./modules/tenants/handlers/index";
import tenantsRouter from './modules/tenants/tenant.router';

import   './interface/index';
import interfaceRouter_Tenant from './interface/tenants/registertenant.router';
import usersRouter from './modules/tenants/routers/users';
import EntityRouter from './modules/core/api/generic.router';
import dashboardRouter from './dashboard/route/route';
import { swaggerRouter } from './config/swagger';
import { publicSearchRouter } from './modules/public/search.service';
import { hotelResponseRouter } from './modules/auth/hotel-response.service';
import { teaRouter } from './modules/tea/tea.service';
import { waWebhookRouter } from './modules/whatsapp/whatsapp.webhook';
import { workflowRouter } from './modules/workflow/workflow.service';

// ── Create app ───────────────────────────────────────────────
export const app = express();

// ── Security middleware ──────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ── Unified CORS configuration ───────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    const allowed = (process.env.FRONTEND_URL || 'http://localhost:4000,http://localhost:5173').split(',');
    if (!origin || allowed.includes(origin) || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed'));
    }
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// ── WhatsApp webhook — raw body capture BEFORE json parser ───
// Meta requires HMAC-SHA256 verification against the raw payload
app.use('/v1/webhooks/whatsapp', express.raw({ type: 'application/json' }), (req, _res, next) => {
  (req as any).rawBody = req.body;
  try { req.body = JSON.parse(req.body.toString()); } catch { req.body = {}; }
  next();
});
app.use('/v1/webhooks/whatsapp', waWebhookRouter);

// ── Body parsers ─────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// ── Global rate limit ────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX||'500'),
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
}));

// ── Request logger ───────────────────────────────────────────
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.debug(`${req.method} ${req.path}`, { ip: req.ip, query: req.query });
  next();
});

// ── Health check — must return 200 immediately (no DB) ───────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'genericdemandai-api', version: '2.0.0' });
});
// /v1/health handled by healthRouter below — returns 200 immediately

// ── CQRS bus status (superadmin debug) ───────────────────────
app.get('/v1/debug/commands', authMiddleware, async (req, res) => {
  if ((req as any).user?.role !== 'superadmin') { res.status(403).json({ error: 'Forbidden' }); return; }
  const { commandBus } = await import('./cqrs/commandBus');
  const { queryBus }   = await import('./cqrs/queryBus');
  res.json({
    commands: commandBus.getRegisteredCommands(),
    //queries:  queryBus.getRegisteredQueries(),
  });
});

app.use('/v1', healthRouter);
app.use('/v1/api-docs', swaggerRouter);

app.use('/v1/ext/tenant', interfaceRouter_Tenant);

// ── PUBLIC ───────────────────────────────────────────────────
app.use('/v1/ext/stores', publicRouter);
app.use('/v1/public', publicSearchRouter);
app.use('/v1/public/hotel-response', hotelResponseRouter);
app.use('/v1/public', workflowRouter);

app.use('/v1/auth',       authRouter);
app.use('/v1/units',      unitsRouter);
app.use('/v1/industries', industryRouter);
app.use('/v1/tenants/:tenantId/stores',dashboardRouter)

app.use('/v1/tenants/:tenantId/dashboard',  authMiddleware,  tenantsRouter);

app.use('/v1/ext/tenants',                                EntityRouter);
app.use('/v1/entity/tenants/:tenantId',                   EntityRouter);

app.use('/v1/tenants/:tenantId/stores',               storeRouter);

// ── PROTECTED — specific tenant sub-routes first, then general tenantRouter ──
app.use('/v1/tenants/:tenantId/coupons',              couponsRouter);          // ← BEFORE tenantRouter
app.use('/v1/tenants/:tenantId/users',                usersRouter);
app.use('/v1/tenants/:tenantId/categories',           categoryRouter);
app.use('/v1/tenants/:tenantId/suppliers',            suppliersRouter);
app.use('/v1/tenants/:tenantId/purchase-orders',     purchaseOrdersRouter);
app.use('/v1/tenants/:tenantId/stores/:storeId/items',   itemRouter);
app.use('/v1/tenants',                                tenantRouter);           // ← AFTER specifics
app.use('/v1/stores/:storeId/sales',   authMiddleware, salesRouter);
app.use('/v1/stores/:storeId/report',          authMiddleware, aiRouter);
app.use('/v1/tenants/:tenantId/ai-settings',   aiSettingsRouter);
app.use('/v1/alerts',                  alertRouter);
app.use('/v1/billing',                 billingRouter);
// app.use('/v1/dashboard',               dashboardRouter);

// ── TEA MODULE ───────────────────────────────────────────────
app.use('/v1/tenants/:tenantId/tea', teaRouter);

// ── SUPERADMIN ROUTER ────────────────────────────────────────
app.use('/v1/superadmin', authMiddleware, superadminRouter);
app.use('/v1/superadmin/coupons', authMiddleware, superadminCouponsRouter);

// ── Request logger ───────────────────────────────────────────
if (process.env.LOG_API_CALLS === 'true') {
  app.use((req: Request, res: Response, next: NextFunction) => {
    logger.info(`API CALL: ${req.method} ${req.originalUrl}`, {
      ip: req.ip,
      query: req.query,
      body: req.body,
    });
    next();
  });
}

// ── 404 handler ──────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: 'Endpoint not found', timestamp: new Date().toISOString() });
});

// ── Global error handler ─────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message, timestamp: new Date().toISOString() });
});
