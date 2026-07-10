"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthRouter = void 0;
const express_1 = require("express");
exports.healthRouter = (0, express_1.Router)();
/**
 * GET /v1/health
 * Basic system health check
 */
exports.healthRouter.get('/health', async (req, res) => {
    try {
        res.status(200).json({
            status: 'ok',
            service: 'DemandGenius API',
            version: '2.0.1',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            environment: process.env.NODE_ENV || 'development',
        });
    }
    catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Health check failed',
            error: error.message,
        });
    }
});
