import { Router } from 'express';

export const healthRouter = Router();

/**
 * GET /v1/health
 * Basic system health check
 */
healthRouter.get('/health', async (req, res) => {
  try {
    res.status(200).json({
      status: 'ok',
      service: 'GenericDemandAI API',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    });
  } catch (error: any) {
    res.status(500).json({
      status: 'error',
      message: 'Health check failed',
      error: error.message,
    });
  }
});