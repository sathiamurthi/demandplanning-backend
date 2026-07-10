"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChangePasswordCommandHandler = exports.DeleteUserCommandHandler = exports.UpdateUserCommandHandler = exports.CreateUserCommandHandler = exports.GetUserByIdQueryHandler = exports.GetUsersQueryHandler = void 0;
const db_1 = require("../../../config/db");
const bcrypt_1 = __importDefault(require("bcrypt"));
class GetUsersQueryHandler {
    async execute(q) {
        const { tenantId, search, storeId, role, isActive } = q.payload;
        let sql = `
      SELECT u.id, u.first_name, u.last_name, u.email, u.role,
             u.is_active, u.last_login_at, u.store_id, u.created_at,
             s.name AS store_name
      FROM users u
      LEFT JOIN stores s ON s.id = u.store_id
      WHERE u.tenant_id = $1
        AND (u.is_deleted IS NOT TRUE)
    `;
        const params = [tenantId];
        if (storeId) {
            params.push(storeId);
            sql += ` AND u.store_id = $${params.length}`;
        }
        if (role) {
            params.push(role);
            sql += ` AND u.role = $${params.length}`;
        }
        if (isActive !== undefined && isActive !== '') {
            params.push(isActive === 'true');
            sql += ` AND u.is_active = $${params.length}`;
        }
        if (search) {
            params.push(`%${search}%`);
            const n = params.length;
            sql += ` AND (u.first_name ILIKE $${n} OR u.last_name ILIKE $${n} OR u.email ILIKE $${n})`;
        }
        sql += ` ORDER BY u.created_at DESC`;
        return (0, db_1.query)(sql, params);
    }
}
exports.GetUsersQueryHandler = GetUsersQueryHandler;
class GetUserByIdQueryHandler {
    async execute(q) {
        const { tenantId, userId } = q.payload;
        const rows = await (0, db_1.query)(`SELECT u.id, u.first_name, u.last_name, u.email, u.role,
              u.is_active, u.last_login_at, u.store_id, s.name AS store_name
       FROM users u
       LEFT JOIN stores s ON s.id = u.store_id
       WHERE u.tenant_id = $1 AND u.id = $2`, [tenantId, userId]);
        return rows[0];
    }
}
exports.GetUserByIdQueryHandler = GetUserByIdQueryHandler;
class CreateUserCommandHandler {
    async execute(c) {
        const { tenantId, payload } = c;
        const passwordHash = await bcrypt_1.default.hash(payload.password || 'Welcome@123', 10);
        const rows = await (0, db_1.query)(`INSERT INTO users
         (tenant_id, store_id, first_name, last_name, email, role, is_active, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, first_name, last_name, email, role, is_active, store_id`, [
            tenantId,
            payload.store_id || null,
            payload.first_name,
            payload.last_name || null,
            payload.email,
            payload.role || 'staff',
            payload.is_active !== false,
            passwordHash,
        ]);
        return rows[0];
    }
}
exports.CreateUserCommandHandler = CreateUserCommandHandler;
class UpdateUserCommandHandler {
    async execute(c) {
        const { tenantId, userId, payload } = c;
        const rows = await (0, db_1.query)(`UPDATE users
       SET first_name = $1,
           last_name  = $2,
           email      = $3,
           role       = $4,
           is_active  = $5,
           store_id   = $6,
           updated_at = NOW()
       WHERE tenant_id = $7 AND id = $8
       RETURNING id, first_name, last_name, email, role, is_active, store_id`, [
            payload.first_name,
            payload.last_name || null,
            payload.email,
            payload.role,
            payload.is_active !== false,
            payload.store_id || null,
            tenantId,
            userId,
        ]);
        return rows[0];
    }
}
exports.UpdateUserCommandHandler = UpdateUserCommandHandler;
class DeleteUserCommandHandler {
    async execute(c) {
        const { tenantId, userId } = c;
        await (0, db_1.query)(`UPDATE users SET is_deleted = true WHERE tenant_id = $1 AND id = $2`, [tenantId, userId]);
    }
}
exports.DeleteUserCommandHandler = DeleteUserCommandHandler;
class ChangePasswordCommandHandler {
    async execute(c) {
        const { tenantId, userId, newPassword } = c;
        const hashed = await bcrypt_1.default.hash(newPassword, 10);
        await (0, db_1.query)(`UPDATE users SET password_hash = $1 WHERE tenant_id = $2 AND id = $3`, [hashed, tenantId, userId]);
    }
}
exports.ChangePasswordCommandHandler = ChangePasswordCommandHandler;
