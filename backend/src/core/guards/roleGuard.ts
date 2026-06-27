import { Request, Response, NextFunction } from 'express';

// Role hierarchy: superadmin > industry_admin > owner > manager > staff > guest
const ROLE_HIERARCHY: Record<string, number> = {
  superadmin: 100,
  industry_admin: 80,
  owner: 60,
  manager: 40,
  staff: 20,
  guest: 5,
};

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user;
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized', timestamp: new Date().toISOString() });
      return;
    }
    if (!roles.includes(user.role)) {
      res.status(403).json({
        success: false,
        error: `Forbidden — requires one of: ${roles.join(', ')}`,
        timestamp: new Date().toISOString()
      });
      return;
    }
    next();
  };
}

export function requireMinRole(minRole: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user;
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized', timestamp: new Date().toISOString() });
      return;
    }
    if ((ROLE_HIERARCHY[user.role] ?? 0) < ROLE_HIERARCHY[minRole]) {
      res.status(403).json({
        success: false,
        error: `Forbidden — requires ${minRole} or higher`,
        timestamp: new Date().toISOString()
      });
      return;
    }
    next();
  };
}

// Tenant isolation: user can only access their own tenant unless superadmin
export function requireTenantAccess() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user;
    const paramTenantId = req.params.tenantId;
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized', timestamp: new Date().toISOString() });
      return;
    }
    if (user.role === 'superadmin') { next(); return; }
    if (paramTenantId && user.tenantId !== paramTenantId) {
      res.status(403).json({ success: false, error: 'Access denied to this tenant', timestamp: new Date().toISOString() });
      return;
    }
    next();
  };
}