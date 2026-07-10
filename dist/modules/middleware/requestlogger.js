"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLogger = requestLogger;
const logger_1 = require("../../config/logger");
function requestLogger(req, res, next) {
    const start = Date.now();
    logger_1.logger.info('i am here before request');
    // 📥 Request log
    logger_1.logger.info('➡️ Incoming Request', {
        method: req.method,
        url: req.originalUrl,
        query: req.query,
        body: req.body,
        tenantId: req.user?.tenantId,
        userId: req.user?.id,
    });
    // 📤 Response log
    res.on('finish', () => {
        logger_1.logger.info('⬅️ Response Sent', {
            method: req.method,
            url: req.originalUrl,
            statusCode: res.statusCode,
            duration: `${Date.now() - start}ms`,
            tenantId: req.user?.tenantId,
        });
    });
    logger_1.logger.info('i am here after request');
    next();
}
