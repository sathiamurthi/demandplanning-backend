// ============================================================
// STORES MODULE
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../config/db';
import { commandBus, ICommand, ICommandHandler } from '../../cqrs/commandBus';
import { queryBus, IQuery, IQueryHandler } from '../../cqrs/queryBus';
import { authMiddleware } from './auth.service';
import { requireRole, requireTenantAccess, requireMinRole } from '../../core/guards/roleGuard';
import { requestLogger } from "../middleware/requestlogger";

function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}

// ── STORE Commands ───────────────────────────────────────────

interface CreateStoreCommand extends ICommand {
  readonly type: 'store.create';
  tenantId: string; name: string; code?: string; ownerName?: string;
  email?: string; phone?: string; address?: string; city?: string;
  state?: string; pincode?: string; gstNumber?: string;
}
class CreateStoreCommandHandler implements ICommandHandler<CreateStoreCommand> {
  async execute(cmd: CreateStoreCommand) {
    // Check plan limits
    const tenant = await queryOne<any>(
      `SELECT t.*, bp.max_stores FROM tenants t JOIN billing_plans bp ON bp.plan_type=t.plan_type WHERE t.id=$1`,
      [cmd.tenantId]
    );
    if (!tenant) throw new Error('Tenant not found');
    if (tenant.max_stores !== -1) {
      const storeCount = await queryOne<any>('SELECT COUNT(*)::int as count FROM stores WHERE tenant_id=$1 AND is_active=TRUE',[cmd.tenantId]);
      if ((storeCount?.count || 0) >= tenant.max_stores) throw new Error(`Plan limit reached: max ${tenant.max_stores} stores`);
    }
    const [store] = await query<any>(
      `INSERT INTO stores (tenant_id,name,code,owner_name,email,phone,address,city,state,pincode,gst_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [cmd.tenantId,cmd.name,cmd.code||null,cmd.ownerName||null,cmd.email||null,cmd.phone||null,
       cmd.address||null,cmd.city||null,cmd.state||null,cmd.pincode||null,cmd.gstNumber||null]
    );
    return store;
  }
}

interface UpdateStoreCommand extends ICommand {
  readonly type: 'store.update';
  storeId: string; tenantId: string;
  name?: string; ownerName?: string; email?: string; phone?: string;
  address?: string; city?: string; state?: string; gstNumber?: string; isActive?: boolean;
}
class UpdateStoreCommandHandler implements ICommandHandler<UpdateStoreCommand> {
  async execute(cmd: UpdateStoreCommand) {
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (cmd.name !== undefined)      { sets.push(`name=$${i++}`);       vals.push(cmd.name); }
    if (cmd.ownerName !== undefined) { sets.push(`owner_name=$${i++}`); vals.push(cmd.ownerName); }
    if (cmd.email !== undefined)     { sets.push(`email=$${i++}`);      vals.push(cmd.email); }
    if (cmd.phone !== undefined)     { sets.push(`phone=$${i++}`);      vals.push(cmd.phone); }
    if (cmd.address !== undefined)   { sets.push(`address=$${i++}`);    vals.push(cmd.address); }
    if (cmd.city !== undefined)      { sets.push(`city=$${i++}`);       vals.push(cmd.city); }
    if (cmd.state !== undefined)     { sets.push(`state=$${i++}`);      vals.push(cmd.state); }
    if (cmd.gstNumber !== undefined) { sets.push(`gst_number=$${i++}`); vals.push(cmd.gstNumber); }
    if (cmd.isActive !== undefined)  { sets.push(`is_active=$${i++}`);  vals.push(cmd.isActive); }
    sets.push(`updated_at=NOW()`);
    vals.push(cmd.storeId, cmd.tenantId);
    const [s] = await query(`UPDATE stores SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING *`, vals);
    if (!s) throw new Error('Store not found');
    return s;
  }
}

// ── STORE Queries ────────────────────────────────────────────

interface ListStoresQuery extends IQuery {
  readonly type: 'store.list';
  tenantId: string; includeInactive?: boolean;
}
class ListStoresQueryHandler implements IQueryHandler<ListStoresQuery, any[]> {
  async execute(q: ListStoresQuery) {
    return query<any>(
      `SELECT s.*,
              COUNT(DISTINCT i.id)::int as item_count,
              COUNT(DISTINCT u.id)::int as user_count,
              COALESCE(SUM(sa.total_amount),0) as month_sales
       FROM stores s
       LEFT JOIN items i ON i.store_id=s.id AND i.is_active=TRUE
       LEFT JOIN users u ON u.store_id=s.id AND u.is_active=TRUE
       LEFT JOIN sales sa ON sa.store_id=s.id AND sa.sale_date >= DATE_TRUNC('month',NOW())
       WHERE s.tenant_id=$1 ${q.includeInactive ? '' : 'AND s.is_active=TRUE'}
       GROUP BY s.id ORDER BY s.created_at`,
      [q.tenantId]
    );
  }
}

interface GetStoreQuery extends IQuery {
  readonly type: 'store.get';
  storeId: string; tenantId: string;
}
class GetStoreQueryHandler implements IQueryHandler<GetStoreQuery, any> {
  async execute(q: GetStoreQuery) {
    const store = await queryOne<any>(
      `SELECT s.*,
              COUNT(DISTINCT i.id)::int as item_count,
              COUNT(DISTINCT u.id)::int as user_count,
              COUNT(DISTINCT i.id) FILTER (WHERE i.current_stock <= i.reorder_level)::int as low_stock_count,
              COUNT(DISTINCT ia.id) FILTER (WHERE ia.is_read=FALSE)::int as unread_alerts
       FROM stores s
       LEFT JOIN items i ON i.store_id=s.id AND i.is_active=TRUE
       LEFT JOIN users u ON u.store_id=s.id AND u.is_active=TRUE
       LEFT JOIN ai_alerts ia ON ia.store_id=s.id
       WHERE s.id=$1 AND s.tenant_id=$2
       GROUP BY s.id`,
      [q.storeId, q.tenantId]
    );
    if (!store) throw new Error('Store not found');
    return store;
  }
}

commandBus.register('store.create', new CreateStoreCommandHandler());
commandBus.register('store.update', new UpdateStoreCommandHandler());
queryBus.register('store.list',     new ListStoresQueryHandler());
queryBus.register('store.get',      new GetStoreQueryHandler());

export const storeRouter = Router({ mergeParams: true });
storeRouter.use(authMiddleware);
storeRouter.use(requireTenantAccess());
storeRouter.use(requestLogger);


const StoreCreateSchema = z.object({
  name: z.string().min(2), code: z.string().optional(),
  ownerName: z.string().optional(), email: z.string().email().optional(),
  phone: z.string().optional(), address: z.string().optional(),
  city: z.string().optional(), state: z.string().optional(),
  pincode: z.string().optional(), gstNumber: z.string().optional(),
});

storeRouter.get("/", async (req, res) => {
  try {
    const tenantId = (req.params as any).tenantId;
    const result = await queryBus.execute({
      type: "store.list",
      tenantId,
      includeInactive: req.query.includeInactive === "true",
    });
    return res.json(apiResponse(result));
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});
storeRouter.post('/', requireRole('superadmin','owner'), async (req, res) => {
  try {
    const body = StoreCreateSchema.parse(req.body);
    const r = await commandBus.execute<any>({ type: 'store.create', tenantId: req.params.tenantId, ...body });
    ok(res, r, 201);
  } catch (e: any) { fail(res, e.message); }
});

storeRouter.get('/:storeId', async (req, res) => {
  try {

    const tenantId = (req.params as any).tenantId;
    const r = await queryBus.execute<any>({ type: 'store.get', storeId: req.params.storeId, tenantId: tenantId });
    ok(res, r);
  } catch (e: any) { fail(res, e.message, 404); }
});

storeRouter.put('/:storeId', requireRole('superadmin','owner'), async (req, res) => {
  try {
    const r = await commandBus.execute<any>({ type: 'store.update', storeId: req.params.storeId, tenantId: req.params.tenantId, ...req.body });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

storeRouter.delete('/:storeId', requireRole('superadmin','owner'), async (req, res) => {
  try {
    await commandBus.execute<any>({ type: 'store.update', storeId: req.params.storeId, tenantId: req.params.tenantId, isActive: false });
    ok(res, { message: 'Store deactivated' });
  } catch (e: any) { fail(res, e.message); }
});

// ============================================================
// USERS MODULE
// ============================================================
import * as bcryptPkg from 'bcryptjs';
import { apiResponse } from '../../utils/response';

interface CreateUserCommand extends ICommand {
  readonly type: 'user.create';
  tenantId: string; email: string; password: string;
  role: string; storeId?: string; firstName: string; lastName: string; phone?: string;
}
class CreateUserCommandHandler implements ICommandHandler<CreateUserCommand> {
  async execute(cmd: CreateUserCommand) {
    const tenant = await queryOne<any>(
      `SELECT t.*, bp.max_users FROM tenants t JOIN billing_plans bp ON bp.plan_type=t.plan_type WHERE t.id=$1`,
      [cmd.tenantId]
    );
    if (!tenant) throw new Error('Tenant not found');
    if (tenant.max_users !== -1) {
      const uc = await queryOne<any>('SELECT COUNT(*)::int as count FROM users WHERE tenant_id=$1 AND is_active=TRUE',[cmd.tenantId]);
      if ((uc?.count||0) >= tenant.max_users) throw new Error(`Plan limit: max ${tenant.max_users} users`);
    }
    const exists = await queryOne('SELECT id FROM users WHERE email=$1',[cmd.email.toLowerCase()]);
    if (exists) throw new Error('Email already registered');
    const hash = await bcryptPkg.hash(cmd.password, 10);
    const [u] = await query<any>(
      `INSERT INTO users (tenant_id,store_id,email,password_hash,role,first_name,last_name,phone,is_active,is_email_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,FALSE) RETURNING id,email,role,first_name,last_name,tenant_id,store_id,created_at`,
      [cmd.tenantId,cmd.storeId||null,cmd.email.toLowerCase(),hash,cmd.role,cmd.firstName,cmd.lastName,cmd.phone||null]
    );
    return u;
  }
}

interface UpdateUserCommand extends ICommand {
  readonly type: 'user.update';
  userId: string; tenantId: string;
  role?: string; storeId?: string | null; isActive?: boolean;
  firstName?: string; lastName?: string; phone?: string;
}
class UpdateUserCommandHandler implements ICommandHandler<UpdateUserCommand> {
  async execute(cmd: UpdateUserCommand) {
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (cmd.role !== undefined)      { sets.push(`role=$${i++}`);       vals.push(cmd.role); }
    if (cmd.storeId !== undefined)   { sets.push(`store_id=$${i++}`);   vals.push(cmd.storeId); }
    if (cmd.isActive !== undefined)  { sets.push(`is_active=$${i++}`);  vals.push(cmd.isActive); }
    if (cmd.firstName !== undefined) { sets.push(`first_name=$${i++}`); vals.push(cmd.firstName); }
    if (cmd.lastName !== undefined)  { sets.push(`last_name=$${i++}`);  vals.push(cmd.lastName); }
    if (cmd.phone !== undefined)     { sets.push(`phone=$${i++}`);      vals.push(cmd.phone); }
    sets.push(`updated_at=NOW()`);
    vals.push(cmd.userId, cmd.tenantId);
    const [u] = await query(`UPDATE users SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING id,email,role,first_name,last_name,is_active`, vals);
    if (!u) throw new Error('User not found');
    return u;
  }
}

interface ListUsersQuery extends IQuery {
  readonly type: 'user.list';
  tenantId: string; storeId?: string; role?: string; isActive?: boolean;
  page: number; limit: number;
}
class ListUsersQueryHandler implements IQueryHandler<ListUsersQuery, any> {
  async execute(q: ListUsersQuery) {
    const conds: string[] = ['u.tenant_id=$1']; const vals: any[] = [q.tenantId]; let i = 2;
    if (q.storeId)             { conds.push(`u.store_id=$${i++}`);   vals.push(q.storeId); }
    if (q.role)                { conds.push(`u.role=$${i++}`);       vals.push(q.role); }
    if (q.isActive !== undefined) { conds.push(`u.is_active=$${i++}`); vals.push(q.isActive); }
    const offset = (q.page - 1) * q.limit;
    const [{ count }] = await query<any>(`SELECT COUNT(*) FROM users u WHERE ${conds.join(' AND ')}`, vals);
    vals.push(q.limit, offset);
    const items = await query<any>(
      `SELECT u.id, u.email, u.role, u.first_name, u.last_name, u.phone, u.is_active,
              u.last_login_at, u.created_at, u.store_id,
              s.name as store_name
       FROM users u
       LEFT JOIN stores s ON s.id=u.store_id
       WHERE ${conds.join(' AND ')} ORDER BY u.created_at DESC LIMIT $${i} OFFSET $${i+1}`, vals
    );
    return { items, total: parseInt(count), page: q.page, limit: q.limit };
  }
}

commandBus.register('user.create', new CreateUserCommandHandler());
commandBus.register('user.update', new UpdateUserCommandHandler());
queryBus.register('user.list',     new ListUsersQueryHandler());

export const userRouter = Router({ mergeParams: true });
userRouter.use(authMiddleware);
userRouter.use(requireTenantAccess());

userRouter.get('/', requireMinRole('manager'), async (req, res) => {
  try {
    const r = await queryBus.execute<any>({
      type: 'user.list', tenantId: req.params.tenantId,
      storeId: req.query.storeId as string,
      role: req.query.role as string,
      isActive: req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined,
      page: parseInt(req.query.page as string)||1,
      limit: parseInt(req.query.limit as string)||20,
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

userRouter.post('/', requireRole('superadmin','owner'), async (req, res) => {
  try {
    const r = await commandBus.execute<any>({ type: 'user.create', tenantId: req.params.tenantId, ...req.body });
    ok(res, r, 201);
  } catch (e: any) { fail(res, e.message); }
});

userRouter.get('/me', async (req, res) => {
  try {
    const user = (req as any).user;
    const u = await queryOne<any>(
      `SELECT u.*, s.name as store_name, t.name as tenant_name, t.industry_id
       FROM users u
       LEFT JOIN stores s ON s.id=u.store_id
       LEFT JOIN tenants t ON t.id=u.tenant_id
       WHERE u.id=$1`, [user.sub]
    );
    ok(res, u);
  } catch (e: any) { fail(res, e.message); }
});

userRouter.get('/:userId', requireRole('superadmin','owner','manager'), async (req, res) => {
  try {
    const u = await queryOne<any>(
      `SELECT u.id, u.email, u.role, u.first_name, u.last_name, u.phone, u.is_active,
              u.last_login_at, u.created_at, u.store_id, s.name as store_name
       FROM users u LEFT JOIN stores s ON s.id=u.store_id
       WHERE u.id=$1 AND u.tenant_id=$2`,
      [req.params.userId, req.params.tenantId]
    );
    if (!u) return fail(res, 'User not found', 404);
    ok(res, u);
  } catch (e: any) { fail(res, e.message); }
});

userRouter.put('/:userId', requireRole('superadmin','owner'), async (req, res) => {
  try {
    const r = await commandBus.execute<any>({ type: 'user.update', userId: req.params.userId, tenantId: req.params.tenantId, ...req.body });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

userRouter.delete('/:userId', requireRole('superadmin','owner'), async (req, res) => {
  try {
    const r = await commandBus.execute({
      type: 'user.update',
      userId: req.params.userId,
      tenantId: req.params.tenantId,
      isActive: false,
    } as UpdateUserCommand);    ok(res, { message: 'User deactivated' });
  } catch (e: any) { fail(res, e.message); }
});