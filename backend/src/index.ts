import dotenv from 'dotenv';
import path from 'path';

dotenv.config({
  path: path.resolve(__dirname, '../.env'),
});

import { app } from './app';
import { pool, runMigrations, checkDbConnection } from './config/db';
import { connectRedis } from './config/redis';
import { logger } from './config/logger';
import { startBackgroundServices } from './modules/public/background.service';

// Force CQRS handlers to register
import "./modules/superadmin/superadmin.controller";
import "./modules/tenants/handlers/index";

const PORT = parseInt(process.env.PORT || '5000');

export async function bootstrap() {
  try {
    console.log("🚀 STEP 1 - bootstrap started");

    logger.info("STEP 2 - logger works");
    console.log("STEP 3 - before DB check");

    // 1. DB check
    const dbOk = await checkDbConnection();
    console.log("STEP 4 - DB checked");

    if (!dbOk) {
      console.log("DB FAILED");
      process.exit(1);
    }

    logger.info("✅ PostgreSQL connected");

    // 2. Migrations
    await runMigrations();
    logger.info("✅ Migrations complete");

    // 3. Redis connect
    await connectRedis();
    logger.info("✅ Redis connected");

    // 4. Start server
    const server = app.listen(PORT);

    server.on('listening', () => {
      console.log(`✅ Server started on port ${PORT}`);
      startBackgroundServices();

      logger.info(`API running on http://localhost:${PORT}`);
      logger.info(`Health: http://localhost:${PORT}/v1/health`);
      logger.info(`API v1: http://localhost:${PORT}/v1`);

      logger.info('');
      logger.info('📋 Available endpoints:');
      logger.info('   ALL /v1/stores');
      logger.info('   POST /v1/auth/login');
      logger.info('   POST /v1/auth/register');
      logger.info('   GET  /v1/tenants [superadmin]');
      logger.info('   POST /v1/tenants [superadmin]');
      logger.info('   GET  /v1/tenants/:id/stores');
      logger.info('   GET  /v1/stores/:id/items');
      logger.info('   POST /v1/stores/:id/sales');
      logger.info('   POST /v1/stores/:id/sales/bulk');
      logger.info('   POST /v1/stores/:id/report/generate [AI]');
      logger.info('   GET  /v1/billing/report [superadmin]');
      logger.info('   SUPERADMIN endpoints: /v1/superadmin/*');
    });

    server.on('error', (err: any) => {
      console.error("❌ Server failed to start:", err);
      logger.error("Server error", err);
      process.exit(1);
    });

    // 6. Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received — shutting down gracefully...`);

      server.close(async () => {
        try {
          await pool.end();
          logger.info('PostgreSQL pool closed');
        } catch (err) {
          logger.error('Error closing pool', err);
        }

        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', (err) => {
      console.error('Uncaught exception:', err);
      logger.error('Uncaught exception', err);
      process.exit(1);
    });

    process.on('unhandledRejection', (err) => {
      console.error('Unhandled rejection:', err);
      logger.error('Unhandled rejection', err);
    });

  } catch (error: any) {
    console.error('Bootstrap failed:', error);
    logger.error('❌ Bootstrap failed', error);
    process.exit(1);
  }
}

// START APP
bootstrap();
