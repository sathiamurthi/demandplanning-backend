"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.userRouter = exports.storeRouter = void 0;
// ============================================================
// STORES MODULE
// ============================================================
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const commandBus_1 = require("../../cqrs/commandBus");
const queryBus_1 = require("../../cqrs/queryBus");
const auth_service_1 = require("./auth.service");
const roleGuard_1 = require("../../core/guards/roleGuard");
const requestlogger_1 = require("../middleware/requestlogger");
function ok(res, data, status = 200) {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res, msg, status = 400) {
    res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}
class CreateStoreCommandHandler {
    async execute(cmd) {
        // Check plan limits
        const tenant = await (0, db_1.queryOne)(`SELECT t.*, bp.max_stores FROM tenants t JOIN billing_plans bp ON bp.plan_type=t.plan_type WHERE t.id=$1`, [cmd.tenantId]);
        if (!tenant)
            throw new Error('Tenant not found');
        if (tenant.max_stores !== -1) {
            const storeCount = await (0, db_1.queryOne)('SELECT COUNT(*)::int as count FROM stores WHERE tenant_id=$1 AND is_active=TRUE', [cmd.tenantId]);
            if ((storeCount?.count || 0) >= tenant.max_stores)
                throw new Error(`Plan limit reached: max ${tenant.max_stores} stores`);
        }
        const [store] = await (0, db_1.query)(`INSERT INTO stores (tenant_id,name,code,owner_name,email,phone,address,city,state,pincode,gst_number,drug_license_number,drug_license_expiry)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [cmd.tenantId, cmd.name, cmd.code || null, cmd.ownerName || null, cmd.email || null, cmd.phone || null,
            cmd.address || null, cmd.city || null, cmd.state || null, cmd.pincode || null, cmd.gstNumber || null,
            cmd.drugLicenseNumber || null, cmd.drugLicenseExpiry || null]);
        return store;
    }
}
class UpdateStoreCommandHandler {
    async execute(cmd) {
        const sets = [];
        const vals = [];
        let i = 1;
        if (cmd.name !== undefined) {
            sets.push(`name=$${i++}`);
            vals.push(cmd.name);
        }
        if (cmd.ownerName !== undefined) {
            sets.push(`owner_name=$${i++}`);
            vals.push(cmd.ownerName);
        }
        if (cmd.email !== undefined) {
            sets.push(`email=$${i++}`);
            vals.push(cmd.email);
        }
        if (cmd.phone !== undefined) {
            sets.push(`phone=$${i++}`);
            vals.push(cmd.phone);
        }
        if (cmd.address !== undefined) {
            sets.push(`address=$${i++}`);
            vals.push(cmd.address);
        }
        if (cmd.city !== undefined) {
            sets.push(`city=$${i++}`);
            vals.push(cmd.city);
        }
        if (cmd.state !== undefined) {
            sets.push(`state=$${i++}`);
            vals.push(cmd.state);
        }
        if (cmd.gstNumber !== undefined) {
            sets.push(`gst_number=$${i++}`);
            vals.push(cmd.gstNumber);
        }
        if (cmd.drugLicenseNumber !== undefined) {
            sets.push(`drug_license_number=$${i++}`);
            vals.push(cmd.drugLicenseNumber);
        }
        if (cmd.drugLicenseExpiry !== undefined) {
            sets.push(`drug_license_expiry=$${i++}`);
            vals.push(cmd.drugLicenseExpiry);
        }
        if (cmd.isActive !== undefined) {
            sets.push(`is_active=$${i++}`);
            vals.push(cmd.isActive);
        }
        sets.push(`updated_at=NOW()`);
        vals.push(cmd.storeId, cmd.tenantId);
        const [s] = await (0, db_1.query)(`UPDATE stores SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i + 1} RETURNING *`, vals);
        if (!s)
            throw new Error('Store not found');
        return s;
    }
}
class ListStoresQueryHandler {
    async execute(q) {
        return (0, db_1.query)(`SELECT s.*,
              COUNT(DISTINCT i.id)::int as item_count,
              COUNT(DISTINCT u.id)::int as user_count,
              COALESCE(SUM(sa.total_amount),0) as month_sales
       FROM stores s
       LEFT JOIN items i ON i.store_id=s.id AND i.is_active=TRUE
       LEFT JOIN users u ON u.store_id=s.id AND u.is_active=TRUE
       LEFT JOIN sales sa ON sa.store_id=s.id AND sa.sale_date >= DATE_TRUNC('month',NOW())
       WHERE s.tenant_id=$1 ${q.includeInactive ? '' : 'AND s.is_active=TRUE'}
       GROUP BY s.id ORDER BY s.created_at`, [q.tenantId]);
    }
}
class GetStoreQueryHandler {
    async execute(q) {
        const store = await (0, db_1.queryOne)(`SELECT s.*,
              COUNT(DISTINCT i.id)::int as item_count,
              COUNT(DISTINCT u.id)::int as user_count,
              COUNT(DISTINCT i.id) FILTER (WHERE i.current_stock <= i.reorder_level)::int as low_stock_count,
              COUNT(DISTINCT ia.id) FILTER (WHERE ia.is_read=FALSE)::int as unread_alerts
       FROM stores s
       LEFT JOIN items i ON i.store_id=s.id AND i.is_active=TRUE
       LEFT JOIN users u ON u.store_id=s.id AND u.is_active=TRUE
       LEFT JOIN ai_alerts ia ON ia.store_id=s.id
       WHERE s.id=$1 AND s.tenant_id=$2
       GROUP BY s.id`, [q.storeId, q.tenantId]);
        if (!store)
            throw new Error('Store not found');
        return store;
    }
}
commandBus_1.commandBus.register('store.create', new CreateStoreCommandHandler());
commandBus_1.commandBus.register('store.update', new UpdateStoreCommandHandler());
queryBus_1.queryBus.register('store.list', new ListStoresQueryHandler());
queryBus_1.queryBus.register('store.get', new GetStoreQueryHandler());
exports.storeRouter = (0, express_1.Router)({ mergeParams: true });
exports.storeRouter.use(auth_service_1.authMiddleware);
exports.storeRouter.use((0, roleGuard_1.requireTenantAccess)());
exports.storeRouter.use(requestlogger_1.requestLogger);
const StoreCreateSchema = zod_1.z.object({
    name: zod_1.z.string().min(2), code: zod_1.z.string().optional(),
    ownerName: zod_1.z.string().optional(), email: zod_1.z.string().email().optional(),
    phone: zod_1.z.string().optional(), address: zod_1.z.string().optional(),
    city: zod_1.z.string().optional(), state: zod_1.z.string().optional(),
    pincode: zod_1.z.string().optional(), gstNumber: zod_1.z.string().optional(),
    drugLicenseNumber: zod_1.z.string().optional(), drugLicenseExpiry: zod_1.z.string().optional(),
});
exports.storeRouter.get("/", async (req, res) => {
    try {
        const tenantId = req.params.tenantId;
        const result = await queryBus_1.queryBus.execute({
            type: "store.list",
            tenantId,
            includeInactive: req.query.includeInactive === "true",
        });
        return res.json((0, response_1.apiResponse)(result));
    }
    catch (e) {
        return res.status(500).json({ error: e.message });
    }
});
exports.storeRouter.post('/', (0, roleGuard_1.requireRole)('superadmin', 'owner'), async (req, res) => {
    try {
        const body = StoreCreateSchema.parse(req.body);
        const r = await commandBus_1.commandBus.execute({ type: 'store.create', tenantId: req.params.tenantId, ...body });
        ok(res, r, 201);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.storeRouter.get('/:storeId', async (req, res) => {
    try {
        const tenantId = req.params.tenantId;
        const r = await queryBus_1.queryBus.execute({ type: 'store.get', storeId: req.params.storeId, tenantId: tenantId });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message, 404);
    }
});
exports.storeRouter.put('/:storeId', (0, roleGuard_1.requireRole)('superadmin', 'owner'), async (req, res) => {
    try {
        const r = await commandBus_1.commandBus.execute({ type: 'store.update', storeId: req.params.storeId, tenantId: req.params.tenantId, ...req.body });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.storeRouter.delete('/:storeId', (0, roleGuard_1.requireRole)('superadmin', 'owner'), async (req, res) => {
    try {
        await commandBus_1.commandBus.execute({ type: 'store.update', storeId: req.params.storeId, tenantId: req.params.tenantId, isActive: false });
        ok(res, { message: 'Store deactivated' });
    }
    catch (e) {
        fail(res, e.message);
    }
});
// ============================================================
// USERS MODULE
// ============================================================
const bcryptPkg = __importStar(require("bcryptjs"));
const response_1 = require("../../utils/response");
class CreateUserCommandHandler {
    async execute(cmd) {
        const tenant = await (0, db_1.queryOne)(`SELECT t.*, bp.max_users FROM tenants t JOIN billing_plans bp ON bp.plan_type=t.plan_type WHERE t.id=$1`, [cmd.tenantId]);
        if (!tenant)
            throw new Error('Tenant not found');
        if (tenant.max_users !== -1) {
            const uc = await (0, db_1.queryOne)('SELECT COUNT(*)::int as count FROM users WHERE tenant_id=$1 AND is_active=TRUE', [cmd.tenantId]);
            if ((uc?.count || 0) >= tenant.max_users)
                throw new Error(`Plan limit: max ${tenant.max_users} users`);
        }
        const exists = await (0, db_1.queryOne)('SELECT id FROM users WHERE email=$1', [cmd.email.toLowerCase()]);
        if (exists)
            throw new Error('Email already registered');
        const hash = await bcryptPkg.hash(cmd.password, 10);
        const [u] = await (0, db_1.query)(`INSERT INTO users (tenant_id,store_id,email,password_hash,role,first_name,last_name,phone,is_active,is_email_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,FALSE) RETURNING id,email,role,first_name,last_name,tenant_id,store_id,created_at`, [cmd.tenantId, cmd.storeId || null, cmd.email.toLowerCase(), hash, cmd.role, cmd.firstName, cmd.lastName, cmd.phone || null]);
        return u;
    }
}
class UpdateUserCommandHandler {
    async execute(cmd) {
        const sets = [];
        const vals = [];
        let i = 1;
        if (cmd.role !== undefined) {
            sets.push(`role=$${i++}`);
            vals.push(cmd.role);
        }
        if (cmd.storeId !== undefined) {
            sets.push(`store_id=$${i++}`);
            vals.push(cmd.storeId);
        }
        if (cmd.isActive !== undefined) {
            sets.push(`is_active=$${i++}`);
            vals.push(cmd.isActive);
        }
        if (cmd.firstName !== undefined) {
            sets.push(`first_name=$${i++}`);
            vals.push(cmd.firstName);
        }
        if (cmd.lastName !== undefined) {
            sets.push(`last_name=$${i++}`);
            vals.push(cmd.lastName);
        }
        if (cmd.phone !== undefined) {
            sets.push(`phone=$${i++}`);
            vals.push(cmd.phone);
        }
        sets.push(`updated_at=NOW()`);
        vals.push(cmd.userId, cmd.tenantId);
        const [u] = await (0, db_1.query)(`UPDATE users SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i + 1} RETURNING id,email,role,first_name,last_name,is_active`, vals);
        if (!u)
            throw new Error('User not found');
        return u;
    }
}
class ListUsersQueryHandler {
    async execute(q) {
        const conds = ['u.tenant_id=$1'];
        const vals = [q.tenantId];
        let i = 2;
        if (q.storeId) {
            conds.push(`u.store_id=$${i++}`);
            vals.push(q.storeId);
        }
        if (q.role) {
            conds.push(`u.role=$${i++}`);
            vals.push(q.role);
        }
        if (q.isActive !== undefined) {
            conds.push(`u.is_active=$${i++}`);
            vals.push(q.isActive);
        }
        const offset = (q.page - 1) * q.limit;
        const [{ count }] = await (0, db_1.query)(`SELECT COUNT(*) FROM users u WHERE ${conds.join(' AND ')}`, vals);
        vals.push(q.limit, offset);
        const items = await (0, db_1.query)(`SELECT u.id, u.email, u.role, u.first_name, u.last_name, u.phone, u.is_active,
              u.last_login_at, u.created_at, u.store_id,
              s.name as store_name
       FROM users u
       LEFT JOIN stores s ON s.id=u.store_id
       WHERE ${conds.join(' AND ')} ORDER BY u.created_at DESC LIMIT $${i} OFFSET $${i + 1}`, vals);
        return { items, total: parseInt(count), page: q.page, limit: q.limit };
    }
}
commandBus_1.commandBus.register('user.create', new CreateUserCommandHandler());
commandBus_1.commandBus.register('user.update', new UpdateUserCommandHandler());
queryBus_1.queryBus.register('user.list', new ListUsersQueryHandler());
exports.userRouter = (0, express_1.Router)({ mergeParams: true });
exports.userRouter.use(auth_service_1.authMiddleware);
exports.userRouter.use((0, roleGuard_1.requireTenantAccess)());
exports.userRouter.get('/', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const r = await queryBus_1.queryBus.execute({
            type: 'user.list', tenantId: req.params.tenantId,
            storeId: req.query.storeId,
            role: req.query.role,
            isActive: req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined,
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || 20,
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.userRouter.post('/', (0, roleGuard_1.requireRole)('superadmin', 'owner'), async (req, res) => {
    try {
        const r = await commandBus_1.commandBus.execute({ type: 'user.create', tenantId: req.params.tenantId, ...req.body });
        ok(res, r, 201);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.userRouter.get('/me', async (req, res) => {
    try {
        const user = req.user;
        const u = await (0, db_1.queryOne)(`SELECT u.*, s.name as store_name, t.name as tenant_name, t.industry_id
       FROM users u
       LEFT JOIN stores s ON s.id=u.store_id
       LEFT JOIN tenants t ON t.id=u.tenant_id
       WHERE u.id=$1`, [user.sub]);
        ok(res, u);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.userRouter.get('/:userId', (0, roleGuard_1.requireRole)('superadmin', 'owner', 'manager'), async (req, res) => {
    try {
        const u = await (0, db_1.queryOne)(`SELECT u.id, u.email, u.role, u.first_name, u.last_name, u.phone, u.is_active,
              u.last_login_at, u.created_at, u.store_id, s.name as store_name
       FROM users u LEFT JOIN stores s ON s.id=u.store_id
       WHERE u.id=$1 AND u.tenant_id=$2`, [req.params.userId, req.params.tenantId]);
        if (!u)
            return fail(res, 'User not found', 404);
        ok(res, u);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.userRouter.put('/:userId', (0, roleGuard_1.requireRole)('superadmin', 'owner'), async (req, res) => {
    try {
        const r = await commandBus_1.commandBus.execute({ type: 'user.update', userId: req.params.userId, tenantId: req.params.tenantId, ...req.body });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.userRouter.delete('/:userId', (0, roleGuard_1.requireRole)('superadmin', 'owner'), async (req, res) => {
    try {
        const r = await commandBus_1.commandBus.execute({
            type: 'user.update',
            userId: req.params.userId,
            tenantId: req.params.tenantId,
            isActive: false,
        });
        ok(res, { message: 'User deactivated' });
    }
    catch (e) {
        fail(res, e.message);
    }
});
