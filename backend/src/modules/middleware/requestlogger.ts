import { Request, Response, NextFunction } from 'express';
import { logger } from '../../config/logger';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  logger.info('i am here before request')
  // 📥 Request log
  logger.info('➡️ Incoming Request', {
    method: req.method,
    url: req.originalUrl,
    query: req.query,
    body: req.body,
    tenantId: (req as any).user?.tenantId,
    userId: (req as any).user?.id,
  });

  // 📤 Response log
  res.on('finish', () => {
    logger.info('⬅️ Response Sent', {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      duration: `${Date.now() - start}ms`,
      tenantId: (req as any).user?.tenantId,
    });

  });
  logger.info('i am here after request')

  next();
}