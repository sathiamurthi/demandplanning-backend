import { query } from "../../config/db";
import bcrypt from "bcrypt";
import { commandBus, ICommand, ICommandHandler } from "../../cqrs/commandBus";
import { queryBus, IQuery, IQueryHandler } from "../../cqrs/queryBus";

// Utility
export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 10;
  return bcrypt.hash(password, saltRounds);
}

/* -----------------------------
   Queries & Command Interfaces
------------------------------ */

// Tenants
export interface GetTenantsQuery extends IQuery {
  readonly type: "superadmin.tenants.get";
}
export class GetTenantsQueryHandler implements IQueryHandler<GetTenantsQuery, any> {
  async execute(q: GetTenantsQuery) {
    return query(
      `SELECT t.id,
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
       ORDER BY t.created_at DESC`
    );
  }
}

export interface ApproveTenantCommand extends ICommand {
  readonly type: "superadmin.tenant.approve";
  tenantId: string;
}
export class ApproveTenantCommandHandler implements ICommandHandler<ApproveTenantCommand, any> {
  async execute(c: ApproveTenantCommand) {
    const result = await query(
      `UPDATE tenants SET billing_status='active', is_active=TRUE, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [c.tenantId]
    );

    // Seed default categories if none exist yet
    const existing = await query(
      `SELECT COUNT(*)::int AS cnt FROM categories WHERE tenant_id=$1`,
      [c.tenantId]
    );
    if ((existing[0] as any)?.cnt === 0) {
      const defaults = [
        { name: "Pharma",    code: "PHARMA",    desc: "Pharmaceutical & medicines" },
        { name: "Groceries", code: "GROCERY",   desc: "General groceries & food items" },
        { name: "Parts",     code: "PARTS",     desc: "Spare parts & components" },
      ];
      for (const cat of defaults) {
        await query(
          `INSERT INTO categories (tenant_id, name, code, description, sort_order)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, name) DO NOTHING`,
          [c.tenantId, cat.name, cat.code, cat.desc, defaults.indexOf(cat)]
        );
      }
    }

    return result;
  }
}

// Users
export interface GetUsersQuery extends IQuery {
  readonly type: "superadmin.users.get";
}
export class GetUsersQueryHandler implements IQueryHandler<GetUsersQuery, any> {
  async execute(q: GetUsersQuery) {
    try {
      return await query(`
        SELECT id, first_name, last_name, email, role, is_email_verified,is_active, tenant_id
        FROM users
        ORDER BY created_at DESC
      `);
    } catch (err) {
      console.error("GetUsersQueryHandler error:", err);
      throw err; // rethrow so you see the real DB error in logs
    }
  }
}

export interface ChangePasswordCommand extends ICommand {
  readonly type: "superadmin.user.password.change";
  userId: string;
  newPassword: string;
}
export class ChangePasswordCommandHandler implements ICommandHandler<ChangePasswordCommand, any> {
  async execute(c: ChangePasswordCommand) {
    const hash = await hashPassword(c.newPassword);
    return query(
      `UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id, email`,
      [hash, c.userId]
    );
  }
}

// Notifications
export interface SendNotificationCommand extends ICommand {
  readonly type: "superadmin.notification.send";
  targetId: string;
  message: string;
}
export class SendNotificationCommandHandler implements ICommandHandler<SendNotificationCommand, any> {
  async execute(c: SendNotificationCommand) {
    return query(
      `INSERT INTO notifications (target, message, created_at) 
       VALUES ($1, $2, NOW()) RETURNING *`,
      [c.targetId, c.message]
    );
  }
}

// Messages
export interface SendMessageCommand extends ICommand {
  readonly type: "superadmin.message.send";
  senderId: string;
  receiverId: string;
  content: string;
}
export class SendMessageCommandHandler implements ICommandHandler<SendMessageCommand, any> {
  async execute(c: SendMessageCommand) {
    return query(
      `INSERT INTO messages (sender_id, receiver_id, content, created_at) 
       VALUES ($1, $2, $3, NOW()) RETURNING *`,
      [c.senderId, c.receiverId, c.content]
    );
  }
}

// Subscriptions
export interface ManageSubscriptionCommand extends ICommand {
  readonly type: "superadmin.subscription.manage";
  tenantId: string;
  plan: string;
}
export class ManageSubscriptionCommandHandler implements ICommandHandler<ManageSubscriptionCommand, any> {
  async execute(c: ManageSubscriptionCommand) {
    return query(
      `INSERT INTO subscriptions (tenant_id, plan, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET plan=$2, updated_at=NOW()
       RETURNING *`,
      [c.tenantId, c.plan]
    );
  }
}

// Users Management
export interface CreateUserCommand extends ICommand {
  readonly type: "superadmin.user.create";
  name: string;
  email: string;
  role: string;
  password: string;
  tenantId?: string;
}
export class CreateUserCommandHandler implements ICommandHandler<CreateUserCommand, any> {
  async execute(c: CreateUserCommand) {
    const hash = await hashPassword(c.password);
    return query(
      `INSERT INTO users (name, email, role, password_hash, tenant_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, name, email, role, tenant_id`,
      [c.name, c.email, c.role, hash, c.tenantId]
    );
  }
}

export interface UpdateUserRoleCommand extends ICommand {
  readonly type: "superadmin.user.role.update";
  userId: string;
  newRole: string;
}
export class UpdateUserRoleCommandHandler implements ICommandHandler<UpdateUserRoleCommand, any> {
  async execute(c: UpdateUserRoleCommand) {
    return query(
      `UPDATE users SET role=$1, updated_at=NOW() WHERE id=$2 RETURNING id, name, email, role`,
      [c.newRole, c.userId]
    );
  }
}

export interface DeactivateUserCommand extends ICommand {
  readonly type: "superadmin.user.deactivate";
  userId: string;
}
export class DeactivateUserCommandHandler implements ICommandHandler<DeactivateUserCommand, any> {
  async execute(c: DeactivateUserCommand) {
    return query(
      `UPDATE users SET status='inactive', updated_at=NOW() WHERE id=$1 RETURNING id, name, email, status`,
      [c.userId]
    );
  }
}

export interface DeleteUserCommand extends ICommand {
  readonly type: "superadmin.user.delete";
  userId: string;
}
export class DeleteUserCommandHandler implements ICommandHandler<DeleteUserCommand, any> {
  async execute(c: DeleteUserCommand) {
    return query(
      `DELETE FROM users WHERE id=$1 RETURNING id, email`,
      [c.userId]
    );
  }
}

/* -----------------------------
   Handler Registration
------------------------------ */

queryBus.register("superadmin.tenants.get", new GetTenantsQueryHandler());
queryBus.register("superadmin.users.get", new GetUsersQueryHandler());

commandBus.register("superadmin.tenant.approve", new ApproveTenantCommandHandler());
commandBus.register("superadmin.user.password.change", new ChangePasswordCommandHandler());
commandBus.register("superadmin.notification.send", new SendNotificationCommandHandler());
commandBus.register("superadmin.message.send", new SendMessageCommandHandler());
commandBus.register("superadmin.subscription.manage", new ManageSubscriptionCommandHandler());
commandBus.register("superadmin.user.create", new CreateUserCommandHandler());
commandBus.register("superadmin.user.role.update", new UpdateUserRoleCommandHandler());
commandBus.register("superadmin.user.deactivate", new DeactivateUserCommandHandler());
commandBus.register("superadmin.user.delete", new DeleteUserCommandHandler());
