"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEA_MODULES = void 0;
exports.requireTeaAccess = requireTeaAccess;
exports.registerTeaRoleRoutes = registerTeaRoleRoutes;
const zod_1 = require("zod");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const db_1 = require("../../config/db");
function ok(res, data, status = 200) {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res, msg, status = 400) {
    res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}
// The permission grid a custom role can be granted — one entry per
// TeaFactory360 nav section that makes sense to delegate. Dashboard,
// Notifications, and Settings are deliberately excluded: dashboard/
// notifications stay universally visible, and settings (billing, store
// config, and this role/team screen itself) stays owner/manager-only
// regardless of any custom role, to avoid a delegated role escalating
// its own or others' access.
exports.TEA_MODULES = [
    { key: 'growers', label: 'Growers' },
    { key: 'collections', label: 'Collections' },
    { key: 'dispatch', label: 'Dispatch' },
    { key: 'settlements', label: 'Settlement & Payments' },
    { key: 'suppliers', label: 'Suppliers & Fuel' },
    { key: 'fleet', label: 'Fleet & Live Map' },
    { key: 'estate', label: 'Estate & Payroll' },
    { key: 'machinery', label: 'Machinery & Vendors' },
    { key: 'inventory', label: 'Inventory' },
    { key: 'sales', label: 'Sales & Auction' },
    { key: 'compliance', label: 'Compliance' },
    { key: 'ai', label: 'AI Assistant' },
    { key: 'reports', label: 'Reports' },
];
const TEA_MODULE_KEYS = new Set(exports.TEA_MODULES.map(m => m.key));
// ── Permission-check middleware ─────────────────────────────────
// Mounted per module-prefix in tea.service.ts, e.g.
//   teaRouter.use('/growers', requireTeaAccess('growers'))
// Purely additive: a user with no custom role assigned (teaRoleId unset)
// is untouched — the existing per-route requireRole() calls remain the
// sole gate for them, exactly as before this feature existed.
function requireTeaAccess(moduleKey) {
    return async (req, res, next) => {
        const user = req.user;
        if (!user)
            return fail(res, 'Unauthorized', 401);
        if (user.role === 'superadmin' || user.role === 'owner' || user.role === 'manager')
            return next();
        if (!user.teaRoleId)
            return next(); // legacy role string — old requireRole() checks still apply
        try {
            const role = await (0, db_1.queryOne)(`SELECT permissions FROM tea_roles WHERE id=$1 AND tenant_id=$2`, [user.teaRoleId, user.tenantId]);
            if (role?.permissions?.[moduleKey] === true)
                return next();
            return fail(res, `Your role does not have access to ${moduleKey}`, 403);
        }
        catch (e) {
            return fail(res, e.message, 500);
        }
    };
}
// ── Roles CRUD ───────────────────────────────────────────────────
const PermissionsSchema = zod_1.z.record(zod_1.z.string(), zod_1.z.boolean());
const RoleCreateSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100),
    permissions: PermissionsSchema.default({}),
});
const RoleUpdateSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100).optional(),
    permissions: PermissionsSchema.optional(),
});
function sanitizePermissions(p) {
    const out = {};
    for (const [k, v] of Object.entries(p || {})) {
        if (TEA_MODULE_KEYS.has(k))
            out[k] = !!v;
    }
    return out;
}
function registerTeaRoleRoutes(router) {
    router.get('/roles/modules', async (_req, res) => {
        ok(res, exports.TEA_MODULES);
    });
    // Any authenticated tea user can read their OWN effective permissions —
    // used by the sidebar to decide what to show, without exposing the full
    // roles/team list (which stays owner/manager-only above).
    router.get('/roles/my-permissions', async (req, res) => {
        const user = req.user;
        if (user.role === 'superadmin' || user.role === 'owner' || user.role === 'manager') {
            return ok(res, { role: user.role, fullAccess: true, permissions: null });
        }
        if (!user.teaRoleId) {
            return ok(res, { role: user.role, fullAccess: false, permissions: null });
        }
        try {
            const teaRole = await (0, db_1.queryOne)(`SELECT name, permissions FROM tea_roles WHERE id=$1 AND tenant_id=$2`, [user.teaRoleId, user.tenantId]);
            ok(res, { role: user.role, fullAccess: false, roleName: teaRole?.name || null, permissions: teaRole?.permissions || {} });
        }
        catch (e) {
            fail(res, e.message);
        }
    });
    router.get('/roles', async (req, res) => {
        const user = req.user;
        if (!['superadmin', 'owner', 'manager'].includes(user.role))
            return fail(res, 'Forbidden', 403);
        try {
            const tenantId = user.tenantId;
            const roles = await (0, db_1.query)(`SELECT r.*, (SELECT COUNT(*)::int FROM users u WHERE u.tea_role_id = r.id) as user_count
         FROM tea_roles r WHERE r.tenant_id=$1 ORDER BY r.created_at ASC`, [tenantId]);
            ok(res, roles);
        }
        catch (e) {
            fail(res, e.message);
        }
    });
    router.post('/roles', async (req, res) => {
        const user = req.user;
        if (!['superadmin', 'owner', 'manager'].includes(user.role))
            return fail(res, 'Forbidden', 403);
        try {
            const body = RoleCreateSchema.parse(req.body);
            const [role] = await (0, db_1.query)(`INSERT INTO tea_roles (tenant_id, name, permissions) VALUES ($1,$2,$3) RETURNING *`, [user.tenantId, body.name, JSON.stringify(sanitizePermissions(body.permissions))]);
            ok(res, role, 201);
        }
        catch (e) {
            fail(res, e.message);
        }
    });
    router.put('/roles/:roleId', async (req, res) => {
        const user = req.user;
        if (!['superadmin', 'owner', 'manager'].includes(user.role))
            return fail(res, 'Forbidden', 403);
        try {
            const body = RoleUpdateSchema.parse(req.body);
            const sets = [];
            const vals = [];
            let i = 1;
            if (body.name !== undefined) {
                sets.push(`name=$${i++}`);
                vals.push(body.name);
            }
            if (body.permissions !== undefined) {
                sets.push(`permissions=$${i++}`);
                vals.push(JSON.stringify(sanitizePermissions(body.permissions)));
            }
            if (!sets.length)
                return fail(res, 'Nothing to update');
            sets.push(`updated_at=NOW()`);
            vals.push(req.params.roleId, user.tenantId);
            const [role] = await (0, db_1.query)(`UPDATE tea_roles SET ${sets.join(',')} WHERE id=$${i++} AND tenant_id=$${i} RETURNING *`, vals);
            if (!role)
                return fail(res, 'Role not found', 404);
            ok(res, role);
        }
        catch (e) {
            fail(res, e.message);
        }
    });
    router.delete('/roles/:roleId', async (req, res) => {
        const user = req.user;
        if (!['superadmin', 'owner', 'manager'].includes(user.role))
            return fail(res, 'Forbidden', 403);
        try {
            // Any user holding this role falls back to their base role (ON
            // DELETE SET NULL on users.tea_role_id) — never left dangling.
            const [role] = await (0, db_1.query)(`DELETE FROM tea_roles WHERE id=$1 AND tenant_id=$2 RETURNING id`, [req.params.roleId, user.tenantId]);
            if (!role)
                return fail(res, 'Role not found', 404);
            ok(res, { message: 'Role deleted', id: role.id });
        }
        catch (e) {
            fail(res, e.message);
        }
    });
    // ── Team CRUD ──────────────────────────────────────────────────
    const TeamCreateSchema = zod_1.z.object({
        firstName: zod_1.z.string().min(1).max(100),
        lastName: zod_1.z.string().max(100).optional(),
        email: zod_1.z.string().email().optional(),
        phone: zod_1.z.string().min(7).max(20).optional(),
        password: zod_1.z.string().min(6).max(100),
        baseRole: zod_1.z.enum(['manager', 'staff', 'agent']).default('staff'),
        teaRoleId: zod_1.z.string().uuid().nullable().optional(),
    }).refine(d => d.email || d.phone, { message: 'Email or phone is required' });
    const TeamUpdateSchema = zod_1.z.object({
        firstName: zod_1.z.string().min(1).max(100).optional(),
        lastName: zod_1.z.string().max(100).optional(),
        baseRole: zod_1.z.enum(['manager', 'staff', 'agent']).optional(),
        teaRoleId: zod_1.z.string().uuid().nullable().optional(),
        isActive: zod_1.z.boolean().optional(),
        password: zod_1.z.string().min(6).max(100).optional(),
    });
    router.get('/team', async (req, res) => {
        const user = req.user;
        if (!['superadmin', 'owner', 'manager'].includes(user.role))
            return fail(res, 'Forbidden', 403);
        try {
            const tenantId = user.tenantId;
            const team = await (0, db_1.query)(`SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.role, u.is_active,
                u.tea_role_id, r.name as tea_role_name, u.last_login_at, u.created_at
         FROM users u
         LEFT JOIN tea_roles r ON r.id = u.tea_role_id
         WHERE u.tenant_id=$1
         ORDER BY u.created_at ASC`, [tenantId]);
            ok(res, team);
        }
        catch (e) {
            fail(res, e.message);
        }
    });
    router.post('/team', async (req, res) => {
        const user = req.user;
        if (!['superadmin', 'owner', 'manager'].includes(user.role))
            return fail(res, 'Forbidden', 403);
        try {
            const body = TeamCreateSchema.parse(req.body);
            const emailNorm = body.email?.toLowerCase().trim() || null;
            const phoneNorm = body.phone?.trim() || null;
            if (emailNorm) {
                const existing = await (0, db_1.queryOne)(`SELECT id FROM users WHERE email=$1`, [emailNorm]);
                if (existing)
                    return fail(res, 'Email already registered');
            }
            if (phoneNorm) {
                const existing = await (0, db_1.queryOne)(`SELECT id FROM users WHERE phone=$1 AND phone<>''`, [phoneNorm]);
                if (existing)
                    return fail(res, 'Phone number already registered');
            }
            if (body.teaRoleId) {
                const role = await (0, db_1.queryOne)(`SELECT id FROM tea_roles WHERE id=$1 AND tenant_id=$2`, [body.teaRoleId, user.tenantId]);
                if (!role)
                    return fail(res, 'Role not found');
            }
            const passwordHash = await bcryptjs_1.default.hash(body.password, 10);
            const [created] = await (0, db_1.query)(`INSERT INTO users (tenant_id, store_id, email, phone, password_hash, role, tea_role_id, first_name, last_name, is_active, reg_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10)
         RETURNING id, email, phone, first_name, last_name, role, tea_role_id, is_active, created_at`, [
                user.tenantId, user.storeId || null,
                emailNorm || `user_${Date.now()}@noemail.local`, phoneNorm, passwordHash,
                body.baseRole, body.teaRoleId || null,
                body.firstName, body.lastName || null,
                phoneNorm && !emailNorm ? 'phone' : 'email',
            ]);
            ok(res, created, 201);
        }
        catch (e) {
            fail(res, e.message);
        }
    });
    router.put('/team/:userId', async (req, res) => {
        const user = req.user;
        if (!['superadmin', 'owner', 'manager'].includes(user.role))
            return fail(res, 'Forbidden', 403);
        try {
            const body = TeamUpdateSchema.parse(req.body);
            if (body.teaRoleId) {
                const role = await (0, db_1.queryOne)(`SELECT id FROM tea_roles WHERE id=$1 AND tenant_id=$2`, [body.teaRoleId, user.tenantId]);
                if (!role)
                    return fail(res, 'Role not found');
            }
            const sets = [];
            const vals = [];
            let i = 1;
            if (body.firstName !== undefined) {
                sets.push(`first_name=$${i++}`);
                vals.push(body.firstName);
            }
            if (body.lastName !== undefined) {
                sets.push(`last_name=$${i++}`);
                vals.push(body.lastName);
            }
            if (body.baseRole !== undefined) {
                sets.push(`role=$${i++}`);
                vals.push(body.baseRole);
            }
            if (body.teaRoleId !== undefined) {
                sets.push(`tea_role_id=$${i++}`);
                vals.push(body.teaRoleId);
            }
            if (body.isActive !== undefined) {
                sets.push(`is_active=$${i++}`);
                vals.push(body.isActive);
            }
            if (body.password) {
                sets.push(`password_hash=$${i++}`);
                vals.push(await bcryptjs_1.default.hash(body.password, 10));
            }
            if (!sets.length)
                return fail(res, 'Nothing to update');
            sets.push(`updated_at=NOW()`);
            vals.push(req.params.userId, user.tenantId);
            const [updated] = await (0, db_1.query)(`UPDATE users SET ${sets.join(',')} WHERE id=$${i++} AND tenant_id=$${i}
         RETURNING id, email, phone, first_name, last_name, role, tea_role_id, is_active`, vals);
            if (!updated)
                return fail(res, 'User not found', 404);
            ok(res, updated);
        }
        catch (e) {
            fail(res, e.message);
        }
    });
    // Deactivate rather than hard-delete, matching the is_active convention
    // used throughout the rest of the platform.
    router.delete('/team/:userId', async (req, res) => {
        const user = req.user;
        if (!['superadmin', 'owner', 'manager'].includes(user.role))
            return fail(res, 'Forbidden', 403);
        if (req.params.userId === user.sub)
            return fail(res, 'You cannot deactivate your own account');
        try {
            const [updated] = await (0, db_1.query)(`UPDATE users SET is_active=FALSE, updated_at=NOW() WHERE id=$1 AND tenant_id=$2 RETURNING id`, [req.params.userId, user.tenantId]);
            if (!updated)
                return fail(res, 'User not found', 404);
            ok(res, { message: 'Team member deactivated', id: updated.id });
        }
        catch (e) {
            fail(res, e.message);
        }
    });
}
