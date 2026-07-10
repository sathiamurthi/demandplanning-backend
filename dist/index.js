"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrap = bootstrap;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config({
    path: path_1.default.resolve(__dirname, '../.env'),
});
const app_1 = require("./app");
const db_1 = require("./config/db");
const redis_1 = require("./config/redis");
const logger_1 = require("./config/logger");
const background_service_1 = require("./modules/public/background.service");
// Force CQRS handlers to register
require("./modules/superadmin/superadmin.controller");
require("./modules/tenants/handlers/index");
const PORT = parseInt(process.env.PORT || '5000');
async function bootstrap() {
    process.on('uncaughtException', (err) => {
        console.error('Uncaught exception:', err);
        logger_1.logger.error('Uncaught exception', err);
        process.exit(1);
    });
    process.on('unhandledRejection', (err) => {
        console.error('Unhandled rejection:', err);
        logger_1.logger.error('Unhandled rejection', err);
    });
    // Start HTTP server immediately so Render health check passes right away
    const server = app_1.app.listen(PORT);
    server.on('error', (err) => {
        console.error("Server failed to start:", err);
        logger_1.logger.error("Server error", err);
        process.exit(1);
    });
    server.on('listening', () => {
        console.log(`Server listening on port ${PORT}`);
        logger_1.logger.info(`API running on http://localhost:${PORT}`);
        // DB init runs after server is up so Render health check passes immediately
        initDb().catch((err) => {
            logger_1.logger.error('DB init failed', err);
        });
    });
    const shutdown = async (signal) => {
        logger_1.logger.info(`${signal} received — shutting down gracefully...`);
        server.close(async () => {
            try {
                await db_1.pool.end();
            }
            catch (_) { }
            process.exit(0);
        });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
async function initDb() {
    try {
        console.log('Waiting for DB connection...');
        await (0, db_1.waitForDb)(10, 5000); // 10 retries x 5s = up to 50s
        logger_1.logger.info('PostgreSQL connected');
        console.log('Running migrations...');
        await (0, db_1.runMigrations)();
        logger_1.logger.info('Migrations complete');
    }
    catch (err) {
        logger_1.logger.error('DB/migration error - API running but DB unavailable', err);
        return;
    }
    try {
        await (0, redis_1.connectRedis)();
        logger_1.logger.info('Redis connected');
    }
    catch (err) {
        logger_1.logger.warn('Redis unavailable - continuing without cache');
    }
    (0, background_service_1.startBackgroundServices)();
    logger_1.logger.info('Background services started');
}
// START APP
bootstrap();
