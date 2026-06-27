"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireRole = requireRole;
exports.requireMinRole = requireMinRole;
exports.requireTenantAccess = requireTenantAccess;
// Role hierarchy: superadmin > industry_admin > owner > manager > staff
const ROLE_HIERARCHY = {
    superadmin: 100,
    industry_admin: 80,
    owner: 60,
    manager: 40,
    staff: 20,
};
function requireRole(...roles) {
    return (req, res, next) => {
        const user = req.user;
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
function requireMinRole(minRole) {
    return (req, res, next) => {
        const user = req.user;
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
function requireTenantAccess() {
    return (req, res, next) => {
        const user = req.user;
        const paramTenantId = req.params.tenantId;
        if (!user) {
            res.status(401).json({ success: false, error: 'Unauthorized', timestamp: new Date().toISOString() });
            return;
        }
        if (user.role === 'superadmin') {
            next();
            return;
        }
        if (paramTenantId && user.tenantId !== paramTenantId) {
            res.status(403).json({ success: false, error: 'Access denied to this tenant', timestamp: new Date().toISOString() });
            return;
        }
        next();
    };
}
