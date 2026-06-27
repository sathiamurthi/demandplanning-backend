import dotenv from 'dotenv';
import path from 'path';

dotenv.config({
  path: path.resolve(__dirname, '../.env'),
});

import { app } from './app';
import { pool, runMigrations, waitForDb } from './config/db';
import { connectRedis } from './config/redis';
import { logger } from './config/logger';
import { startBackgroundServices } from './modules/public/background.service';

// Force CQRS handlers to register
import "./modules/superadmin/superadmin.controller";
import "./modules/tenants/handlers/index";

const PORT = parseInt(process.env.PORT || '5000');

export async function bootstrap() {
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    logger.error('Uncaught exception', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    logger.error('Unhandled rejection', err);
  });

  // Start HTTP server immediately so Render health check passes right away
  const server = app.listen(PORT);

  server.on('error', (err: any) => {
    console.error("Server failed to start:", err);
    logger.error("Server error", err);
    process.exit(1);
  });

  server.on('listening', () => {
    console.log(`Server listening on port ${PORT}`);
    logger.info(`API running on http://localhost:${PORT}`);

    // DB init runs after server is up so Render health check passes immediately
    initDb().catch((err) => {
      logger.error('DB init failed', err);
    });
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down gracefully...`);
    server.close(async () => {
      try { await pool.end(); } catch (_) {}
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function initDb() {
  try {
    console.log('Waiting for DB connection...');
    await waitForDb(10, 5000); // 10 retries x 5s = up to 50s
    logger.info('PostgreSQL connected');

    console.log('Running migrations...');
    await runMigrations();
    logger.info('Migrations complete');
  } catch (err) {
    logger.error('DB/migration error - API running but DB unavailable', err);
    return;
  }

  try {
    await connectRedis();
    logger.info('Redis connected');
  } catch (err) {
    logger.warn('Redis unavailable - continuing without cache');
  }

  startBackgroundServices();
  logger.info('Background services started');
}

// START APP
bootstrap();
