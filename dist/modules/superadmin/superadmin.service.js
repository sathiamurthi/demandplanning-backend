"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeleteUserCommandHandler = exports.DeactivateUserCommandHandler = exports.UpdateUserRoleCommandHandler = exports.CreateUserCommandHandler = exports.ManageSubscriptionCommandHandler = exports.SendMessageCommandHandler = exports.SendNotificationCommandHandler = exports.ChangePasswordCommandHandler = exports.GetUsersQueryHandler = exports.ApproveTenantCommandHandler = exports.GetTenantsQueryHandler = void 0;
exports.hashPassword = hashPassword;
const db_1 = require("../../config/db");
const bcrypt_1 = __importDefault(require("bcrypt"));
const commandBus_1 = require("../../cqrs/commandBus");
const queryBus_1 = require("../../cqrs/queryBus");
// Utility
async function hashPassword(password) {
    const saltRounds = 10;
    return bcrypt_1.default.hash(password, saltRounds);
}
class GetTenantsQueryHandler {
    async execute(q) {
        return (0, db_1.query)(`SELECT t.id,
              t.name              AS company_name,
              t.billing_email     AS admin_email,
              t.billing_status    AS status,
              t.is_active,
              t.plan_type,
              t.slug,
              t.city,
              t.created_at,
              COUNT(DISTINCT s.id)::int  AS store_count,
              COUNT(DISTINCT u.id)::int  AS user_count
       FROM tenants t
       LEFT JOIN stores s ON s.tenant_id = t.id
       LEFT JOIN users  u ON u.tenant_id = t.id
       GROUP BY t.id
       ORDER BY t.created_at DESC`);
    }
}
exports.GetTenantsQueryHandler = GetTenantsQueryHandler;
class ApproveTenantCommandHandler {
    async execute(c) {
        const result = await (0, db_1.query)(`UPDATE tenants SET billing_status='active', is_active=TRUE, updated_at=NOW() WHERE id=$1 RETURNING *`, [c.tenantId]);
        // Seed default categories if none exist yet
        const existing = await (0, db_1.query)(`SELECT COUNT(*)::int AS cnt FROM categories WHERE tenant_id=$1`, [c.tenantId]);
        if (existing[0]?.cnt === 0) {
            const defaults = [
                { name: "Pharma", code: "PHARMA", desc: "Pharmaceutical & medicines" },
                { name: "Groceries", code: "GROCERY", desc: "General groceries & food items" },
                { name: "Parts", code: "PARTS", desc: "Spare parts & components" },
            ];
            for (const cat of defaults) {
                await (0, db_1.query)(`INSERT INTO categories (tenant_id, name, code, description, sort_order)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, name) DO NOTHING`, [c.tenantId, cat.name, cat.code, cat.desc, defaults.indexOf(cat)]);
            }
        }
        return result;
    }
}
exports.ApproveTenantCommandHandler = ApproveTenantCommandHandler;
class GetUsersQueryHandler {
    async execute(q) {
        try {
            return await (0, db_1.query)(`
        SELECT id, first_name, last_name, email, role, is_email_verified,is_active, tenant_id
        FROM users
        ORDER BY created_at DESC
      `);
        }
        catch (err) {
            console.error("GetUsersQueryHandler error:", err);
            throw err; // rethrow so you see the real DB error in logs
        }
    }
}
exports.GetUsersQueryHandler = GetUsersQueryHandler;
class ChangePasswordCommandHandler {
    async execute(c) {
        const hash = await hashPassword(c.newPassword);
        return (0, db_1.query)(`UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id, email`, [hash, c.userId]);
    }
}
exports.ChangePasswordCommandHandler = ChangePasswordCommandHandler;
class SendNotificationCommandHandler {
    async execute(c) {
        return (0, db_1.query)(`INSERT INTO notifications (target, message, created_at) 
       VALUES ($1, $2, NOW()) RETURNING *`, [c.targetId, c.message]);
    }
}
exports.SendNotificationCommandHandler = SendNotificationCommandHandler;
class SendMessageCommandHandler {
    async execute(c) {
        return (0, db_1.query)(`INSERT INTO messages (sender_id, receiver_id, content, created_at) 
       VALUES ($1, $2, $3, NOW()) RETURNING *`, [c.senderId, c.receiverId, c.content]);
    }
}
exports.SendMessageCommandHandler = SendMessageCommandHandler;
class ManageSubscriptionCommandHandler {
    async execute(c) {
        return (0, db_1.query)(`INSERT INTO subscriptions (tenant_id, plan, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET plan=$2, updated_at=NOW()
       RETURNING *`, [c.tenantId, c.plan]);
    }
}
exports.ManageSubscriptionCommandHandler = ManageSubscriptionCommandHandler;
class CreateUserCommandHandler {
    async execute(c) {
        const hash = await hashPassword(c.password);
        return (0, db_1.query)(`INSERT INTO users (name, email, role, password_hash, tenant_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, name, email, role, tenant_id`, [c.name, c.email, c.role, hash, c.tenantId]);
    }
}
exports.CreateUserCommandHandler = CreateUserCommandHandler;
class UpdateUserRoleCommandHandler {
    async execute(c) {
        return (0, db_1.query)(`UPDATE users SET role=$1, updated_at=NOW() WHERE id=$2 RETURNING id, name, email, role`, [c.newRole, c.userId]);
    }
}
exports.UpdateUserRoleCommandHandler = UpdateUserRoleCommandHandler;
class DeactivateUserCommandHandler {
    async execute(c) {
        return (0, db_1.query)(`UPDATE users SET status='inactive', updated_at=NOW() WHERE id=$1 RETURNING id, name, email, status`, [c.userId]);
    }
}
exports.DeactivateUserCommandHandler = DeactivateUserCommandHandler;
class DeleteUserCommandHandler {
    async execute(c) {
        return (0, db_1.query)(`DELETE FROM users WHERE id=$1 RETURNING id, email`, [c.userId]);
    }
}
exports.DeleteUserCommandHandler = DeleteUserCommandHandler;
/* -----------------------------
   Handler Registration
------------------------------ */
queryBus_1.queryBus.register("superadmin.tenants.get", new GetTenantsQueryHandler());
queryBus_1.queryBus.register("superadmin.users.get", new GetUsersQueryHandler());
commandBus_1.commandBus.register("superadmin.tenant.approve", new ApproveTenantCommandHandler());
commandBus_1.commandBus.register("superadmin.user.password.change", new ChangePasswordCommandHandler());
commandBus_1.commandBus.register("superadmin.notification.send", new SendNotificationCommandHandler());
commandBus_1.commandBus.register("superadmin.message.send", new SendMessageCommandHandler());
commandBus_1.commandBus.register("superadmin.subscription.manage", new ManageSubscriptionCommandHandler());
commandBus_1.commandBus.register("superadmin.user.create", new CreateUserCommandHandler());
commandBus_1.commandBus.register("superadmin.user.role.update", new UpdateUserRoleCommandHandler());
commandBus_1.commandBus.register("superadmin.user.deactivate", new DeactivateUserCommandHandler());
commandBus_1.commandBus.register("superadmin.user.delete", new DeleteUserCommandHandler());
